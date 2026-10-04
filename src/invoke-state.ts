import { createAbortError } from './utils'

interface InvokeCancelState {
  materialized: boolean
  reason?: unknown
}

/**
 * Owns request reconstruction and cancellation correlation for one handler.
 *
 * Cancellation is allowed to arrive before request data. Bounded cancellation
 * state keeps that reason until the first request frame materializes exactly one
 * handler invocation; later frames for the cancelled invocation are ignored.
 */
export class InvokeState<Req> {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly invokeCancelStates = new Map<string, InvokeCancelState>()
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

  constructor(
    private readonly contextSignal: AbortSignal,
    private readonly maxCancelStates = 10_000,
  ) {
    if (contextSignal.aborted) {
      this.onContextAbort()
      return
    }
    contextSignal.addEventListener('abort', this.onContextAbort, { once: true })
  }

  shouldIgnoreFrame(invokeId: string): boolean {
    if (this.contextSignal.aborted) {
      return true
    }

    // Once an abort has been correlated with an invocation, every later frame
    // for that invoke is late and must not start or re-enter the handler.
    return this.invokeCancelStates.get(invokeId)?.materialized === true
  }

  materialize(invokeId: string): AbortController {
    const controller = new AbortController()
    this.abortControllers.set(invokeId, controller)

    if (this.contextSignal.aborted) {
      this.scheduleAbort(controller, this.contextSignal.reason)
    }

    const cancellation = this.invokeCancelStates.get(invokeId)
    if (!cancellation) {
      return controller
    }

    // The first request/end/error frame materializes an early-aborted invoke.
    // The handler may be invoked once to observe cancellation, but later frames
    // must not start a second invocation.
    const reason = cancellation.reason
    cancellation.materialized = true
    cancellation.reason = undefined
    this.scheduleAbort(controller, reason)
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
    const abortController = this.abortControllers.get(invokeId)
    const streamController = this.streamControllers.get(invokeId)
    const cancellation = this.invokeCancelStates.get(invokeId)

    // A materialized cancellation has already been applied to this invoke.
    // Repeated abort frames must not restart correlation or replace its state.
    if (cancellation?.materialized) {
      return
    }

    if (cancellation) {
      // The request has not arrived yet. Keep the latest reason for the first
      // request/end/error frame that materializes this cancelled invoke.
      cancellation.reason = reason
    }
    else {
      // No active state means abort won the race and must be remembered without
      // starting the handler. Active state means the handler/stream is already
      // running and this abort is recorded before it is cancelled below.
      const isActive = abortController !== undefined || streamController !== undefined
      this.invokeCancelStates.set(invokeId, {
        materialized: isActive,
        reason: isActive ? undefined : reason,
      })
    }

    // Bound cancellation state for aborts whose request never arrives. Keep
    // insertion order so pressure evicts the oldest correlation record.
    while (this.invokeCancelStates.size > this.maxCancelStates) {
      const oldest = this.invokeCancelStates.keys().next()
      if (oldest.done) {
        break
      }
      this.invokeCancelStates.delete(oldest.value)
    }

    if (abortController) {
      this.scheduleAbort(abortController, reason)
    }

    if (!streamController) {
      return
    }

    streamController.error(createAbortError(reason))
    this.streamControllers.delete(invokeId)
  }

  complete(invokeId: string): void {
    this.abortControllers.delete(invokeId)
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
    const cancellation = this.invokeCancelStates.get(invokeId)
    if (!cancellation) {
      return false
    }
    controller.error(createAbortError(cancellation.reason))
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
