import type { EventContext } from './context'
import type {
  InvokeEventa,
  ReceiveEvent,
  ReceiveEventError,
  ReceiveEventStreamEnd,
} from './invoke-shared'

import { defineEventa, nanoid } from './eventa'

export function defineStreamInvoke<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  E = any,
  EO = any,
>(clientCtx: EventContext<E, EO>, event: InvokeEventa<Res, Req, ResErr, ReqErr>) {
  return (req: Req) => {
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

    clientCtx.emit(event.sendEvent, { invokeId, content: req }) // emit: event_trigger
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

export function defineStreamInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  E = any,
  EO extends { raw?: any } = any,
>(serverCtx: EventContext<E, EO>, event: InvokeEventa<Res, Req, ResErr, ReqErr>, fn: StreamHandler<Res, Req, EO>) {
  serverCtx.on(event.sendEvent, async (payload, options) => { // on: event_trigger
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const invokeReceiveEvent = defineEventa(`${event.receiveEvent.id}-${payload.body.invokeId}`) as ReceiveEvent<Res>
    const invokeReceiveEventError = defineEventa(`${event.receiveEventError.id}-${payload.body.invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>
    const invokeReceiveEventStreamEnd = defineEventa(`${event.receiveEventStreamEnd.id}-${payload.body.invokeId}`) as ReceiveEventStreamEnd<Res>

    try {
      const generator = fn(payload.body.content as Req, options) // Call the handler function with the request payload
      for await (const res of generator) {
        serverCtx.emit(invokeReceiveEvent, { ...payload.body, content: res }, options) // emit: event_response
      }

      serverCtx.emit(invokeReceiveEventStreamEnd, { ...payload.body, content: undefined }, options) // emit: event_stream_end
    }
    catch (error) {
      serverCtx.emit(invokeReceiveEventError, { ...payload.body, content: { error: error as ResErr } }, options) // emit: event_response with error
    }
  })
}

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
