import type { EventContext } from './context'
import type { Eventa } from './eventa'
import type { InvokeEventa, ReceiveEvent, ReceiveEventError, SendEvent, SendEventStreamEnd } from './invoke-shared'

import { defineEventa, nanoid } from './eventa'
import { isReceiveEvent } from './invoke-shared'
import { isAsyncIterable, isReadableStream } from './utils'

type IsInvokeRequestOptional<EC extends EventContext<any, any>>
  = EC extends EventContext<infer E, any>
    ? E extends { invokeRequest: any }
      ? undefined extends E['invokeRequest']
        ? true
        : false
      : E extends { invokeRequest?: any }
        ? undefined extends E['invokeRequest']
          ? true
          : false
        : true
    : true

type ExtractInvokeRequest<EC extends EventContext<any, any>>
  = EC extends EventContext<infer E, any>
    ? E extends { invokeRequest: infer IR }
      ? IR
      : E extends { invokeRequest?: infer IR }
        ? IR
        : undefined
    : undefined

type ExtractInvokeResponse<EC extends EventContext<any, any>>
  = EC extends EventContext<infer E, any>
    ? E extends { invokeResponse: infer IR }
      ? IR
      : E extends { invokeResponse?: infer IR }
        ? IR
        : undefined
    : undefined

export type InvokeFunction<Res, Req, EC extends EventContext<any, any>>
  = [Req] extends [undefined]
    ? IsInvokeRequestOptional<EC> extends true
      ? (req?: Req, invokeRequest?: ExtractInvokeRequest<EC>) => Promise<Res>
      : (req: Req, invokeRequest: ExtractInvokeRequest<EC>) => Promise<Res>
    : IsInvokeRequestOptional<EC> extends true
      ? (req: Req, invokeRequest?: ExtractInvokeRequest<EC>) => Promise<Res>
      : (req: Req, invokeRequest: ExtractInvokeRequest<EC>) => Promise<Res>

export type InvokeFunctionMap<EventMap extends Record<string, InvokeEventa<any, any, any, any>>, EC extends EventContext<any, any>> = {
  [K in keyof EventMap]: EventMap[K] extends InvokeEventa<infer Res, infer Req, any, any> ? InvokeFunction<Res, Req, EC> : never
}

export type ExtendableInvokeResponse<Res, EC extends EventContext<any, any>>
  = | Promise<Res>
    | Res
    | Promise<{ response: Res, invokeResponse?: ExtractInvokeResponse<EC> }>
    | { response: Res, invokeResponse?: ExtractInvokeResponse<EC> }

export function isExtendableInvokeResponseLike<Res, EC extends EventContext<any, any>>(value: Eventa<unknown> | ReceiveEvent<{ response: Res, invokeResponse?: unknown }>): value is ReceiveEvent<{ response: Res, invokeResponse?: ExtractInvokeResponse<EC> }> {
  if (!isReceiveEvent(value)) {
    return false
  }

  return typeof value.body?.content === 'object'
    && value.body?.content != null
    && 'response' in value.body.content
    && (
      !('invokeResponse' in value.body.content)
      || (
        'invokeResponse' in value.body.content
        && (
          typeof value.body.content.invokeResponse === 'object'
          || typeof value.body.content.invokeResponse === 'undefined'
        )
      )
    )
}

export type Handler<Res, Req = any, EC extends EventContext<any, any> = EventContext<any, any>, RawEventOptions = unknown> = (
  payload: Req,
  options?: {
    /**
     * TODO: Support aborting invoke handlers
     */
    abortController?: AbortController
  } & RawEventOptions,
) => ExtendableInvokeResponse<Res, EC>

interface InternalInvokeHandler<
  Res,
  Req = any,
  ResErr = Error,
  ReqErr = Error,
  EO = any,
> {
  onSend: (params: InvokeEventa<Res, Req, ResErr, ReqErr>['sendEvent'], eventOptions?: EO) => void
  onSendStreamEnd: (params: InvokeEventa<Res, Req, ResErr, ReqErr>['sendEventStreamEnd'], eventOptions?: EO) => void
}

export type HandlerMap<
  EventMap extends Record<string, InvokeEventa<any, any, any, any>>,
  EO = any,
  EC extends EventContext<any, any> = EventContext<any, any>,
> = {
  [K in keyof EventMap]: EventMap[K] extends InvokeEventa<infer Res, infer Req, any, any>
    ? Handler<Res, Req, EC, EO>
    : never
}

export interface InvocableEventContext<E, EO> extends EventContext<E, EO> {
  invokeHandlers?: Map<string, Map<Handler<any>, InternalInvokeHandler<any>>>
}

/**
 * Create a unary invoke function (client side).
 *
 * It supports unary or streaming requests, but returns a single response.
 * Use `defineStreamInvoke` when you expect a stream of responses.
 *
 * If you want stream input, set `Req` to `ReadableStream<T>` or `AsyncIterable<T>`
 * (or a union type like `T | ReadableStream<T>` for optional streaming).
 *
 * @example
 * ```ts
 * // 1) Define eventa once (shared by client/server)
 * const events = defineInvokeEventa<{ id: string }, { name: string }>()
 *
 * // 2) Client: define invoke function
 * const invoke = defineInvoke(clientCtx, events)
 *
 * // 3) Call
 * const res = await invoke({ name: 'alice' })
 * ```
 *
 * @example
 * ```ts
 * // Stream request -> unary response
 * const events = defineInvokeEventa<number, ReadableStream<number>>()
 *
 * defineInvokeHandler(serverCtx, events, async (payload) => {
 *   let sum = 0
 *   for await (const value of payload) {
 *     sum += value
 *   }
 *
 *   return sum
 * })
 *
 * const invoke = defineInvoke(clientCtx, events)
 * const input = new ReadableStream<number>({
 *   start(controller) {
 *     controller.enqueue(1)
 *     controller.enqueue(2)
 *     controller.close()
 *   },
 * })
 *
 * const total = await invoke(input)
 * ```
 *
 * @param ctx Event context on the caller/client side.
 * @param event Invoke event definition created by `defineInvokeEventa`.
 */
export function defineInvoke<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  CtxExt = any,
  EOpts = any,
  ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
>(ctx: ECtx, event: InvokeEventa<Res, Req, ResErr, ReqErr>): InvokeFunction<Res, Req, ECtx> {
  const mInvokeIdPromiseResolvers = new Map<string, (value: Res | PromiseLike<Res>) => void>()
  const mInvokeIdPromiseRejectors = new Map<string, (err?: any) => void>()

  function _invoke(req?: Req, options?: { invokeRequest?: ExtractInvokeRequest<ECtx> }): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const invokeId = nanoid()
      mInvokeIdPromiseResolvers.set(invokeId, resolve)
      mInvokeIdPromiseRejectors.set(invokeId, reject)

      const invokeReceiveEvent = defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res>
      const invokeReceiveEventError = defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr>

      ctx.on(invokeReceiveEvent, (payload) => {
        if (!payload.body) {
          return
        }
        if (payload.body.invokeId !== invokeId) {
          return
        }

        const { content } = payload.body
        mInvokeIdPromiseResolvers.get(invokeId)?.(content as Res)
        mInvokeIdPromiseResolvers.delete(invokeId)
        mInvokeIdPromiseRejectors.delete(invokeId)
        ctx.off(invokeReceiveEvent)
        ctx.off(invokeReceiveEventError)
      })

      ctx.on(invokeReceiveEventError, (payload) => {
        if (!payload.body) {
          return
        }
        if (payload.body.invokeId !== invokeId) {
          return
        }

        const { error } = payload.body.content
        mInvokeIdPromiseRejectors.get(invokeId)?.(error)
        mInvokeIdPromiseRejectors.delete(invokeId)
        mInvokeIdPromiseResolvers.delete(invokeId)
        ctx.off(invokeReceiveEvent)
        ctx.off(invokeReceiveEventError)
      })

      if (!isReadableStream<Req>(req) && !isAsyncIterable<Req>(req)) {
        ctx.emit(event.sendEvent, { invokeId, content: req as Req }, options as any) // emit: event_trigger
      }
      else {
        const sendChunk = (chunk: Req) => {
          ctx.emit(event.sendEvent, { invokeId, content: chunk, isReqStream: true }, options as any) // emit: event_trigger
        }

        const sendEnd = () => {
          ctx.emit(event.sendEventStreamEnd, { invokeId, content: undefined }, options as any) // emit: event_stream_end
        }

        const pump = async () => {
          try {
            for await (const chunk of req) {
              sendChunk(chunk)
            }

            sendEnd()
          }
          catch (error) {
            ctx.emit(event.sendEventError, { invokeId, content: error as ReqErr }, options as any) // emit: event_error
          }
        }

        pump()
      }
    })
  }

  return _invoke as InvokeFunction<Res, Req, ECtx>
}

/**
 * Create a map of invoke functions from a map of invoke events (client side).
 *
 * @example
 * ```ts
 * const events = {
 *   double: defineInvokeEventa<number, number>(),
 *   greet: defineInvokeEventa<string, { name: string }>(),
 * }
 *
 * const invokes = defineInvokes(ctx, events)
 * const result = await invokes.double(2)
 * ```
 *
 * @param ctx Event context on the caller/client side.
 * @param events Map of invoke events created by `defineInvokeEventa`.
 */
export function defineInvokes<
  EK extends string,
  EventMap extends Record<EK, InvokeEventa<any, any, any, any>>,
  CtxExt = any,
  EOpts = any,
  ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
>(ctx: ECtx, events: EventMap): InvokeFunctionMap<EventMap, ECtx> {
  const invokes = (Object.keys(events) as EK[]).reduce((invokes, key) => {
    invokes[key] = defineInvoke(ctx, events[key])
    return invokes
  }, {} as Record<EK, InvokeFunction<any, any, ECtx>>)

  return invokes as InvokeFunctionMap<EventMap, ECtx>
}

/**
 * Define a unary invoke handler (server side).
 *
 * The handler can accept a unary or streaming request; it must return
 * a single response (or an extendable response envelope).
 *
 * @example
 * ```ts
 * const events = defineInvokeEventa<{ id: string }, { name: string }>()
 *
 * defineInvokeHandler(serverCtx, events, ({ name }) => ({
 *   id: `user-${name}`,
 * }))
 * ```
 *
 * @param ctx Event context on the handler/server side.
 * @param event Invoke event definition created by `defineInvokeEventa`.
 * @param handler Handler that returns a response (or response + metadata).
 */
export function defineInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  CtxExt = any,
  EOpts extends { raw?: any } = any,
>(
  ctx: InvocableEventContext<CtxExt, EOpts>,
  event: InvokeEventa<Res, Req, ResErr, ReqErr>,
  handler: Handler<Res, Req, InvocableEventContext<CtxExt, EOpts>, EOpts>,
): () => void {
  if (!ctx.invokeHandlers) {
    ctx.invokeHandlers = new Map()
  }

  let handlers = ctx.invokeHandlers?.get(event.sendEvent.id)
  if (!handlers) {
    handlers = new Map()
    ctx.invokeHandlers?.set(event.sendEvent.id, handlers)
  }

  let internalHandler = handlers.get(handler) as InternalInvokeHandler<Res, Req, ResErr, ReqErr, EOpts> | undefined
  if (!internalHandler) {
    const streamStates = new Map<string, ReadableStreamDefaultController<Req>>()

    const handleInvoke = async (invokeId: string, payload: Req, options?: EOpts) => {
      try {
        const response = await handler(payload as Req, options) // Call the handler function with the request payload
        ctx.emit(
          { ...defineEventa(`${event.receiveEvent.id}-${invokeId}`), invokeType: event.receiveEvent.invokeType } as ReceiveEvent<ExtendableInvokeResponse<Res, InvocableEventContext<CtxExt, EOpts>>>,
          { invokeId, content: response },
          options,
        ) // emit: event_response
      }
      catch (error) {
        // TODO: to error object
        ctx.emit(
          { ...defineEventa(`${event.receiveEventError.id}-${invokeId}`), invokeType: event.receiveEventError.invokeType } as ReceiveEventError<Res, Req, ResErr, ReqErr>,
          { invokeId, content: { error: error as ResErr } },
          options,
        )
      }
    }

    const onSend = async (payload: SendEvent<Res, Req, ResErr, ReqErr>, options: EOpts) => { // on: event_trigger
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
          // TODO: perhaps, can we correctly write type Req here?
          handleInvoke(invokeId, reqStream as Req, options)
        }

        controller.enqueue(payload.body.content as Req)
        return
      }

      handleInvoke(invokeId, payload.body?.content as Req, options)
    }

    const onSendStreamEnd = (payload: SendEventStreamEnd<Res, Req, ResErr, ReqErr>, options: EOpts) => { // on: event_stream_end
      if (!payload.body) {
        return
      }
      if (!payload.body.invokeId) {
        return
      }

      const invokeId = payload.body.invokeId
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
        // TODO: perhaps, can we correctly write type Req here?
        handleInvoke(invokeId, reqStream as Req, options)
      }

      controller.close()
      streamStates.delete(invokeId)
    }

    internalHandler = { onSend, onSendStreamEnd }
    handlers.set(handler, internalHandler)

    ctx.on(event.sendEvent, internalHandler.onSend)
    ctx.on(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
  }

  return () => {
    ctx.off(event.sendEvent, internalHandler.onSend)
    ctx.off(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
  }
}

/**
 * Define multiple invoke handlers in batch (server side).
 *
 * @example
 * ```ts
 * const events = {
 *   double: defineInvokeEventa<number, number>(),
 *   greet: defineInvokeEventa<string, { name: string }>(),
 * }
 *
 * defineInvokeHandlers(ctx, events, {
 *   double: value => value * 2,
 *   greet: ({ name }) => `hi ${name}`,
 * })
 * ```
 *
 * @param ctx Event context on the handler/server side.
 * @param events Map of invoke events created by `defineInvokeEventa`.
 * @param handlers Map of handlers keyed by event name.
 */
export function defineInvokeHandlers<
  EK extends string,
  EventMap extends Record<EK, InvokeEventa<any, any, any, any>>,
  CtxExt = any,
  EOpts extends { raw?: any } = any,
>(
  ctx: InvocableEventContext<CtxExt, EOpts>,
  events: EventMap,
  handlers: HandlerMap<EventMap, EOpts>,
): Record<EK, () => void> {
  const eventKeys = Object.keys(events) as EK[]
  const handlerKeys = new Set(Object.keys(handlers) as EK[])

  if (eventKeys.length !== handlerKeys.size || !eventKeys.every(key => handlerKeys.has(key))) {
    throw new Error('The keys of events and handlers must match.')
  }

  return eventKeys.reduce((returnValues, key) => {
    returnValues[key] = defineInvokeHandler(ctx, events[key], handlers[key])
    return returnValues
  }, {} as Record<EK, () => void>)
}

/**
 * Remove one or all invoke handlers for a specific invoke event (server side).
 *
 * @example
 * ```ts
 * const off = defineInvokeHandler(ctx, events, handler)
 * off() // remove one handler
 *
 * // or remove all handlers for the event:
 * undefineInvokeHandler(ctx, events)
 * ```
 *
 * @param ctx Event context on the handler/server side.
 * @param event Invoke event definition created by `defineInvokeEventa`.
 * @param handler Specific handler to remove (omit to remove all).
 * @returns `true` if at least one handler was removed, `false` otherwise
 */
export function undefineInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  CtxExt = any,
  EOpts = any,
>(
  ctx: InvocableEventContext<CtxExt, EOpts>,
  event: InvokeEventa<Res, Req, ResErr, ReqErr>,
  handler?: Handler<Res, Req, InvocableEventContext<CtxExt, EOpts>, EOpts>,
): boolean {
  if (!ctx.invokeHandlers)
    return false

  const handlers = ctx.invokeHandlers?.get(event.sendEvent.id)
  if (!handlers)
    return false

  if (handler) {
    const internalHandler = handlers.get(handler)
    if (!internalHandler)
      return false

    ctx.off(event.sendEvent, internalHandler.onSend)
    ctx.off(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
    ctx.invokeHandlers.delete(event.sendEvent.id)

    return true
  }

  let returnValue = false
  for (const internalHandlers of handlers.values()) {
    ctx.off(event.sendEvent, internalHandlers.onSend)
    ctx.off(event.sendEventStreamEnd, internalHandlers.onSendStreamEnd)
    returnValue = true
  }

  ctx.invokeHandlers.delete(event.sendEvent.id)

  return returnValue
}
