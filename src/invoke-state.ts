import { createAbortError } from './utils'

/**
 * Owns request reconstruction and cancellation correlation for one handler.
 *
 * Cancellation is allowed to arrive before request data. A bounded tombstone
 * keeps that reason until the first request frame materializes exactly one
 * handler invocation; later frames for the cancelled invocation are ignored.
 */
export class InvokeState<Req> {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly abortReasons = new Map<string, unknown>()
  private readonly materializedInvocations = new Set<string>()
  private readonly streamControllers = new Map<string, ReadableStreamDefaultController<Req>>()

  /**
   * Propagates the owning context lifetime into active invocation state.
   *
   * Triggering workflow:
   *
   * {@link AbortController.abort}
   *   -> {@link AbortSignal.addEventListener}
   *     -> `abort`
   *       -> {@link InvokeState.onContextAbort}
   *
   * Upstream:
   * - {@link AbortController.abort}
   *
   * Downstream:
   * - {@link AbortController.abort}
   * - {@link ReadableStreamDefaultController.error}
   */
  private readonly onContextAbort = () => {
    for (const controller of this.abortControllers.values()) {
      this.scheduleAbort(controller, this.contextSignal.reason)
    }
    for (const controller of this.streamControllers.values()) {
      controller.error(createAbortError(this.contextSignal.reason))
    }
    this.streamControllers.clear()
  }

  constructor(private readonly contextSignal: AbortSignal) {
    if (contextSignal.aborted) {
      this.onContextAbort()
      return
    }
    contextSignal.addEventListener('abort', this.onContextAbort, { once: true })
  }

  shouldIgnoreFrame(invokeId: string): boolean {
    return this.contextSignal.aborted
      || (this.abortReasons.has(invokeId) && this.materializedInvocations.has(invokeId))
  }

  materialize(invokeId: string): AbortController {
    const controller = new AbortController()
    this.abortControllers.set(invokeId, controller)
    this.materializedInvocations.add(invokeId)

    if (this.contextSignal.aborted) {
      this.scheduleAbort(controller, this.contextSignal.reason)
    }
    if (this.abortReasons.has(invokeId)) {
      this.scheduleAbort(controller, this.abortReasons.get(invokeId))
    }
    return controller
  }

  openRequestStream(invokeId: string): {
    controller: ReadableStreamDefaultController<Req>
    stream?: ReadableStream<Req>
  } {
    const existing = this.streamControllers.get(invokeId)
    if (existing) {
      return { controller: existing }
    }

    let controller!: ReadableStreamDefaultController<Req>
    const stream = new ReadableStream<Req>({
      start(value) {
        controller = value
      },
    })
    this.streamControllers.set(invokeId, controller)
    return { controller, stream }
  }

  pushRequestChunk(invokeId: string, controller: ReadableStreamDefaultController<Req>, value: Req): boolean {
    if (this.errorCancelledStream(invokeId, controller)) {
      return false
    }
    controller.enqueue(value)
    return true
  }

  endRequestStream(invokeId: string, controller: ReadableStreamDefaultController<Req>): boolean {
    if (this.errorCancelledStream(invokeId, controller)) {
      return false
    }
    controller.close()
    this.streamControllers.delete(invokeId)
    return true
  }

  errorRequestStream(invokeId: string, controller: ReadableStreamDefaultController<Req>, error: unknown): void {
    controller.error(error)
    this.streamControllers.delete(invokeId)
  }

  rememberAbort(invokeId: string, reason: unknown): void {
    this.abortReasons.delete(invokeId)
    this.abortReasons.set(invokeId, reason)

    // Bound cancellation tombstones whose request never arrives. Deleting and
    // reinserting above also refreshes the insertion order for repeated aborts.
    while (this.abortReasons.size > 10_000) {
      const oldestInvokeId = this.abortReasons.keys().next().value
      if (typeof oldestInvokeId !== 'string') {
        break
      }
      this.abortReasons.delete(oldestInvokeId)
      this.materializedInvocations.delete(oldestInvokeId)
    }

    const abortController = this.abortControllers.get(invokeId)
    if (abortController) {
      this.scheduleAbort(abortController, reason)
    }

    const streamController = this.streamControllers.get(invokeId)
    if (streamController) {
      streamController.error(createAbortError(reason))
      this.streamControllers.delete(invokeId)
    }
  }

  complete(invokeId: string): void {
    this.abortControllers.delete(invokeId)
    if (this.abortReasons.has(invokeId)) {
      this.streamControllers.delete(invokeId)
      return
    }
    this.materializedInvocations.delete(invokeId)
  }

  dispose(): void {
    this.contextSignal.removeEventListener('abort', this.onContextAbort)
  }

  private errorCancelledStream(invokeId: string, controller: ReadableStreamDefaultController<Req>): boolean {
    if (this.contextSignal.aborted) {
      controller.error(createAbortError(this.contextSignal.reason))
      this.streamControllers.delete(invokeId)
      return true
    }
    if (!this.abortReasons.has(invokeId)) {
      return false
    }
    controller.error(createAbortError(this.abortReasons.get(invokeId)))
    this.streamControllers.delete(invokeId)
    return true
  }

  private scheduleAbort(controller: AbortController, reason: unknown): void {
    // Defer abort until the handler has created any streams or async iterables
    // that need to observe the cancellation signal.
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => controller.abort(reason))
      return
    }
    void Promise.resolve().then(() => controller.abort(reason))
  }
}
