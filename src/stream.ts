import type { EventContext } from './context'
import type { ExtractInvokeRequestOptions } from './invoke'
import type {
  InvokeEventa,
  ReceiveEvent,
  ReceiveEventError,
  ReceiveEventStreamEnd,
} from './invoke-shared'

import { defineEventa, nanoid } from './eventa'
import { InvokeState } from './invoke-state'
import { createAbortError, isAsyncIterable, isReadableStream } from './utils'

/**
 * Create a stream invoke function (client side).
 *
 * Use when the response is streamed and the request may be unary or streaming.
 * Request and response chunks are ordered within this invocation even though
 * the underlying context does not order independent emits.
 *
 * Common patterns:
 * - Unary request -> stream response (server-streaming)
 * - Stream request -> stream response (bi-directional streaming)
 *
 * @example
 * ```ts
 * // 1) Define eventa once (shared by client/server)
 * const events = defineInvokeEventa<Progress | Result, Params>()
 *
 * // 2) Client: define invoke function
 * const invoke = defineStreamInvoke(clientCtx, events)
 *
 * // 3) Call with unary request
 * for await (const msg of invoke({ name: 'alice' })) {
 *   console.log(msg)
 * }
 * ```
 *
 * @example
 * ```ts
 * // Client-streaming request
 * const input = new ReadableStream<number>({
 *   start(c) { c.enqueue(1); c.enqueue(2); c.close() },
 * })
 *
 * for await (const msg of invoke(input)) {
 *   console.log(msg)
 * }
 * ```
 *
 * @param clientCtx Event context on the caller/client side.
 * @param event Invoke event definition created by `defineInvokeEventa`.
 */
export function defineStreamInvoke<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  E = any,
  EO = any,
>(clientCtx: EventContext<E, EO>, event: InvokeEventa<Res, Req, ResErr, ReqErr>) {
  return (req: Req | ReadableStream<Req> | AsyncIterable<Req>, options?: ExtractInvokeRequestOptions<EventContext<E, EO>>) => {
    const invokeId = nanoid()
    const { signal, ...emitOptions } = (options ?? {}) as ExtractInvokeRequestOptions<EventContext<E, EO>> & Record<string, unknown>
    const requestEmitOptions = emitOptions as EO
    let onAbort: (() => void) | undefined
    let onContextAbort: (() => void) | undefined
    let stopped = false
    let cleanup = () => void 0
    let finishError = (_reason: unknown) => void 0

    const invokeReceiveEvent = defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res>
    const invokeReceiveEventError = defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>
    const invokeReceiveEventStreamEnd = defineEventa(`${event.receiveEventStreamEnd.id}-${invokeId}`) as ReceiveEventStreamEnd<Res>

    const sendAbort = (reason: unknown) => {
      void clientCtx.emit(event.sendEventAbort, { invokeId, content: reason }, requestEmitOptions).catch(() => void 0)
    }

    const stream = new ReadableStream<Res>({
      start(controller) {
        cleanup = () => {
          clientCtx.off(invokeReceiveEvent)
          clientCtx.off(invokeReceiveEventError)
          clientCtx.off(invokeReceiveEventStreamEnd)
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort)
          }
          if (onContextAbort) {
            clientCtx.signal.removeEventListener('abort', onContextAbort)
          }
        }

        finishError = (reason) => {
          if (stopped) {
            return
          }
          stopped = true
          controller.error(reason)
          cleanup()
        }

        onAbort = () => {
          sendAbort(signal?.reason)
          finishError(createAbortError(signal?.reason))
        }
        onContextAbort = () => finishError(clientCtx.signal.reason)

        clientCtx.on(invokeReceiveEvent, (payload) => {
          if (!payload.body) {
            return
          }
          if (payload.body.invokeId !== invokeId) {
            return
          }
          if (stopped) {
            return
          }
          controller.enqueue(payload.body.content as Res)
        })
        clientCtx.on(invokeReceiveEventError, (payload) => {
          if (!payload.body) {
            return
          }
          if (payload.body.invokeId !== invokeId) {
            return
          }

          finishError(payload.body.content.error as ResErr)
        })
        clientCtx.on(invokeReceiveEventStreamEnd, (payload) => {
          if (!payload.body) {
            return
          }
          if (payload.body.invokeId !== invokeId) {
            return
          }

          if (stopped) {
            return
          }
          stopped = true
          controller.close()
          cleanup()
        })

        if (clientCtx.signal.aborted) {
          onContextAbort()
          return
        }
        clientCtx.signal.addEventListener('abort', onContextAbort, { once: true })

        if (signal && onAbort) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort as EventListener, { once: true })
        }
      },
      cancel(reason) {
        if (!stopped) {
          stopped = true
          sendAbort(reason)
        }
        cleanup()
      },
    })

    if (stopped) {
      return stream
    }

    if (isReadableStream<Req>(req) || isAsyncIterable<Req>(req)) {
      const sendChunk = (chunk: Req) => {
        return clientCtx.emit(event.sendEvent, { invokeId, content: chunk, isReqStream: true }, requestEmitOptions) // emit: event_trigger
      }

      const sendEnd = () => {
        return clientCtx.emit(event.sendEventStreamEnd, { invokeId, content: undefined }, requestEmitOptions) // emit: event_stream_end
      }

      const pump = async () => {
        let sending = false
        try {
          // Context emits are unordered across calls. Await each frame here so
          // this invocation's chunks cannot be overtaken by its end frame.
          for await (const chunk of req) {
            if (stopped) {
              return
            }

            sending = true
            await sendChunk(chunk)
            sending = false
            if (stopped) {
              return
            }
          }

          if (stopped) {
            return
          }
          sending = true
          await sendEnd()
        }
        catch (error) {
          if (sending) {
            sendAbort(error)
          }
          else {
            finishError(error)
            try {
              await clientCtx.emit(event.sendEventError, { invokeId, content: error as ReqErr }, requestEmitOptions)
            }
            catch (publishError) {
              // The error frame may follow partial request data. If publishing
              // it fails, try to terminate that remote request explicitly.
              sendAbort(publishError)
            }
          }
          if (sending) {
            finishError(error)
          }
        }
      }

      void pump()
    }
    else {
      void clientCtx.emit(event.sendEvent, { invokeId, content: req }, requestEmitOptions).catch(finishError) // emit: event_trigger
    }

    return stream
  }
}

type StreamHandler<Res, Req = any, RawEventOptions = unknown> = (
  payload: Req,
  options?: {
    abortController?: AbortController
  } & RawEventOptions,
) => AsyncGenerator<Res, void, unknown>

/**
 * Define a stream invoke handler (server side).
 *
 * The handler can receive either:
 * - a unary request `Req`
 * - a streaming request `ReadableStream<Req>` / `AsyncIterable<Req>`
 *
 * It must return an async generator of response messages.
 *
 * Triggering workflow:
 *
 * {@link defineStreamInvoke}
 *   -> {@link EventContext.on}
 *     -> `sendEvent` / `sendEventError` / `sendEventStreamEnd` / `sendEventAbort`
 *       -> {@link defineStreamInvokeHandler}
 *
 * Upstream:
 * - {@link defineStreamInvoke}
 *
 * Downstream:
 * - {@link EventContext.emit}
 *
 * @example
 * ```ts
 * const events = defineInvokeEventa<Progress | Result, Params>()
 *
 * defineStreamInvokeHandler(serverCtx, events, async function* (payload) {
 *   if (isReadableStream<Params>(payload) || isAsyncIterable<Params>(payload)) {
 *     for await (const item of payload) {
 *       yield { type: 'progress', value: item }
 *     }
 *   }
 *
 *   yield { type: 'result', ok: true }
 * })
 * ```
 *
 * @param serverCtx Event context on the handler/server side.
 * @param event Invoke event definition created by `defineInvokeEventa`.
 * @param fn Stream handler that yields response chunks.
 * @returns A disposer that removes protocol listeners and context-lifetime tracking. Active handlers keep running; their request streams and abort controllers remain valid until those handlers settle.
 */
export function defineStreamInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  E = any,
  EO extends { raw?: any } = any,
>(serverCtx: EventContext<E, EO>, event: InvokeEventa<Res, Req, ResErr, ReqErr>, fn: StreamHandler<Res, Req, EO>): () => void {
  const invokeReceiveEvent = (invokeId: string) => defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res>
  const invokeReceiveEventError = (invokeId: string) => defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>
  const invokeReceiveEventStreamEnd = (invokeId: string) => defineEventa(`${event.receiveEventStreamEnd.id}-${invokeId}`) as ReceiveEventStreamEnd<Res>
  const requestState = new InvokeState<Req>(serverCtx.signal)

  const handleInvoke = async (invokeId: string, payload: Req, options?: EO) => {
    const receiveEvent = invokeReceiveEvent(invokeId)
    const receiveEventError = invokeReceiveEventError(invokeId)
    const receiveEventStreamEnd = invokeReceiveEventStreamEnd(invokeId)
    const abortController = requestState.materialize(invokeId)

    const handlerOptions = options
      ? { ...options, abortController }
      : ({ abortController } as EO & { abortController: AbortController })

    try {
      const generator = fn(payload, handlerOptions) // Call the handler function with the request payload
      // Response ordering belongs to this invocation pump, not EventContext.
      // Awaiting each emit keeps chunks ahead of the matching end frame.
      for await (const res of generator) {
        await serverCtx.emit(receiveEvent, { invokeId, content: res }, options) // emit: event_response
      }

      await serverCtx.emit(receiveEventStreamEnd, { invokeId, content: undefined }, options) // emit: event_stream_end
    }
    catch (error) {
      try {
        await serverCtx.emit(receiveEventError, { invokeId, content: { error: error as ResErr } }, options) // emit: event_response with error
      }
      catch {
        // The response transport is already unavailable; there is no remaining
        // route on which to report its own send failure.
      }
    }
    finally {
      requestState.complete(invokeId)
    }
  }

  const offSend = serverCtx.on(event.sendEvent, async (payload, options) => { // on: event_trigger
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const invokeId = payload.body.invokeId
    if (requestState.shouldIgnoreFrame(invokeId)) {
      return
    }
    if (payload.body.isReqStream) {
      const { controller, stream } = requestState.openRequestStream(invokeId)
      if (stream) {
        // TODO: can we write type Req here correctly?
        handleInvoke(invokeId, stream as Req, options)
      }
      requestState.pushRequestChunk(invokeId, controller, payload.body.content as Req)
      return
    }

    handleInvoke(invokeId, payload.body.content as Req, options)
  })

  const offStreamEnd = serverCtx.on(event.sendEventStreamEnd, (payload, options) => { // on: event_stream_end
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const invokeId = payload.body.invokeId
    if (requestState.shouldIgnoreFrame(invokeId)) {
      return
    }

    const { controller, stream } = requestState.openRequestStream(invokeId)
    if (stream) {
      handleInvoke(invokeId, stream as Req, options)
    }
    requestState.endRequestStream(invokeId, controller)
  })

  const offSendError = serverCtx.on(event.sendEventError, (payload, options) => {
    if (!payload.body?.invokeId) {
      return
    }

    const invokeId = payload.body.invokeId
    if (requestState.shouldIgnoreFrame(invokeId)) {
      return
    }
    const { controller, stream } = requestState.openRequestStream(invokeId)
    if (stream) {
      handleInvoke(invokeId, stream as Req, options)
    }
    requestState.errorRequestStream(invokeId, controller, payload.body.content)
  })

  const offAbort = serverCtx.on(event.sendEventAbort, (payload) => { // on: event_abort
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    requestState.rememberAbort(payload.body.invokeId, payload.body.content)
  })

  return () => {
    offSend()
    offSendError()
    offStreamEnd()
    offAbort()
    requestState.dispose()
  }
}

/**
 * Convert a callback-style handler into a stream handler.
 *
 * Use `emit` to push response chunks, and return when done.
 * Works for unary or streaming requests.
 *
 * @example
 * ```ts
 * defineStreamInvokeHandler(ctx, events, toStreamHandler(async ({ payload, emit }) => {
 *   if (isReadableStream<Params>(payload) || isAsyncIterable<Params>(payload)) {
 *     for await (const item of payload) {
 *       emit({ type: 'progress', value: item })
 *     }
 *
 *     emit({ type: 'result', ok: true })
 *     return
 *   }
 *
 *   emit({ type: 'result', ok: true })
 * }))
 * ```
 *
 * @param handler Callback handler with `emit` for streaming responses.
 */
export function toStreamHandler<Req, Res, EO extends { raw?: any } = any>(handler: (context: { payload: Req, options?: EO, emit: (data: Res) => void }) => Promise<void>): StreamHandler<Res, Req, EO> {
  return (payload, options) => {
    const values: Promise<[Res, boolean]>[] = []
    let resolve: (x: [Res, boolean]) => void
    let handlerError: Error | null = null

    values.push(new Promise((r) => {
      resolve = r
    }))

    const emit = (data: Res) => {
      resolve([data, false])

      values.push(new Promise((r) => {
        resolve = r
      }))
    }

    // Start the handler and mark completion when done
    handler({ payload, options, emit })
      .then(() => {
        resolve([undefined as any, true])
      })
      .catch((err) => {
        handlerError = err
        resolve([undefined as any, true])
      })

    return (async function* () {
      let val: Res

      for (let i = 0, done = false; !done; i++) {
        [val, done] = await values[i]
        delete values[i] // Clean up memory

        if (handlerError) {
          throw handlerError
        }

        if (!done) {
          yield val
        }
      }
    }())
  }
}
