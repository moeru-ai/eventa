import type { EventContext } from './context'
import type {
  InvokeEventa,
  ReceiveEvent,
  ReceiveEventError,
  ReceiveEventStreamEnd,
} from './invoke-shared'

import { defineEventa, nanoid } from './eventa'
import { isAsyncIterable, isReadableStream } from './utils'

/**
 * Create a stream invoke function (client side).
 *
 * Use when the response is streamed and the request may be unary or streaming.
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
  return (req: Req | ReadableStream<Req> | AsyncIterable<Req>) => {
    const invokeId = nanoid()

    const invokeReceiveEvent = defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res>
    const invokeReceiveEventError = defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>
    const invokeReceiveEventStreamEnd = defineEventa(`${event.receiveEventStreamEnd.id}-${invokeId}`) as ReceiveEventStreamEnd<Res>

    const stream = new ReadableStream<Res>({
      start(controller) {
        clientCtx.on(invokeReceiveEvent, (payload) => {
          if (!payload.body) {
            return
          }
          if (payload.body.invokeId !== invokeId) {
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

          controller.error(payload.body.content.error as ResErr)
        })
        clientCtx.on(invokeReceiveEventStreamEnd, (payload) => {
          if (!payload.body) {
            return
          }
          if (payload.body.invokeId !== invokeId) {
            return
          }

          controller.close()
        })
      },
      cancel() {
        clientCtx.off(invokeReceiveEvent)
        clientCtx.off(invokeReceiveEventError)
        clientCtx.off(invokeReceiveEventStreamEnd)
      },
    })

    if (isReadableStream<Req>(req) || isAsyncIterable<Req>(req)) {
      const sendChunk = (chunk: Req) => {
        clientCtx.emit(event.sendEvent, { invokeId, content: chunk, isReqStream: true }) // emit: event_trigger
      }

      const sendEnd = () => {
        clientCtx.emit(event.sendEventStreamEnd, { invokeId, content: undefined }) // emit: event_stream_end
      }

      const pump = async () => {
        try {
          for await (const chunk of req) {
            sendChunk(chunk)
          }

          sendEnd()
        }
        catch (error) {
          clientCtx.emit(event.sendEventError, { invokeId, content: error as ReqErr }) // emit: event_error
        }
      }

      pump()
    }
    else {
      clientCtx.emit(event.sendEvent, { invokeId, content: req }) // emit: event_trigger
    }

    return stream
  }
}

type StreamHandler<Res, Req = any, RawEventOptions = unknown> = (
  payload: Req,
  options?: {
    /**
     * TODO: Support aborting invoke handlers
     */
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
 */
export function defineStreamInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  E = any,
  EO extends { raw?: any } = any,
>(serverCtx: EventContext<E, EO>, event: InvokeEventa<Res, Req, ResErr, ReqErr>, fn: StreamHandler<Res, Req, EO>) {
  const invokeReceiveEvent = (invokeId: string) => defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res>
  const invokeReceiveEventError = (invokeId: string) => defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>
  const invokeReceiveEventStreamEnd = (invokeId: string) => defineEventa(`${event.receiveEventStreamEnd.id}-${invokeId}`) as ReceiveEventStreamEnd<Res>
  const streamStates = new Map<string, ReadableStreamDefaultController<Req>>()

  const handleInvoke = async (invokeId: string, payload: Req, options?: EO) => {
    const receiveEvent = invokeReceiveEvent(invokeId)
    const receiveEventError = invokeReceiveEventError(invokeId)
    const receiveEventStreamEnd = invokeReceiveEventStreamEnd(invokeId)

    try {
      const generator = fn(payload, options) // Call the handler function with the request payload
      for await (const res of generator) {
        serverCtx.emit(receiveEvent, { invokeId, content: res }, options) // emit: event_response
      }

      serverCtx.emit(receiveEventStreamEnd, { invokeId, content: undefined }, options) // emit: event_stream_end
    }
    catch (error) {
      serverCtx.emit(receiveEventError, { invokeId, content: { error: error as ResErr } }, options) // emit: event_response with error
    }
  }

  serverCtx.on(event.sendEvent, async (payload, options) => { // on: event_trigger
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const invokeId = payload.body.invokeId
    if (payload.body.isReqStream) {
      let controller = streamStates.get(invokeId)
      if (!controller) {
        let localController: ReadableStreamDefaultController<Req>
        const reqStream = new ReadableStream<Req>({
          start(c) {
            localController = c
          },
        })

        controller = localController!
        streamStates.set(invokeId, controller)
        // TODO: can we write type Req here correctly?
        handleInvoke(invokeId, reqStream as Req, options)
      }

      controller.enqueue(payload.body.content as Req)
      return
    }

    handleInvoke(invokeId, payload.body.content as Req, options)
  })

  serverCtx.on(event.sendEventStreamEnd, (payload) => { // on: event_stream_end
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const controller = streamStates.get(payload.body.invokeId)
    if (!controller) {
      return
    }

    controller.close()
    streamStates.delete(payload.body.invokeId)
  })
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
