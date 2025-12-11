import type { EventContext } from './context'
import type { Eventa } from './eventa'
import type { InvokeEventa, ReceiveEvent, ReceiveEventError } from './invoke-shared'

import { defineEventa, nanoid } from './eventa'
import { isReceiveEvent } from './invoke-shared'

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

type InternalInvokeHandler<
  Res,
  Req = any,
  ResErr = Error,
  ReqErr = Error,
  EO = any,
> = (params: InvokeEventa<Res, Req, ResErr, ReqErr>['sendEvent'], eventOptions?: EO) => void

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

  function _invoke(req: Req, options?: { invokeRequest?: ExtractInvokeRequest<ECtx> }): Promise<Res> {
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

      ctx.emit(event.sendEvent, { invokeId, content: req }, options as any) // emit: event_trigger
    })
  }

  return _invoke as InvokeFunction<Res, Req, ECtx>
}

export function defineInvokes<
  EK extends string,
  EventMap extends Record<EK, InvokeEventa<any, any, any, any>>,
  CtxExt = any,
  EOpts = any,
  ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
>(ctx: ECtx, events: EventMap): InvokeFunctionMap<EventMap, ECtx> {
  return (Object.keys(events) as EK[]).reduce((invokes, key) => {
    invokes[key] = defineInvoke(ctx, events[key])
    return invokes
  }, {} as Record<EK, InvokeFunction<any, any, ECtx>>) as InvokeFunctionMap<EventMap, ECtx>
}

/**
 * Define an invoke handler for a specific invoke event.
 *
 * @param ctx The event context in which to define the invoke handler.
 * @param event The invoke event for which the handler is to be defined.
 * @param handler The handler function to be invoked when the event is triggered.
 * @returns A function that can be called to remove the invoke handler.
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
    internalHandler = async (payload, options) => { // on: event_trigger
      if (!payload.body) {
        return
      }
      if (!payload.body.invokeId) {
        return
      }

      try {
        const response = await handler(payload.body?.content as Req, options) // Call the handler function with the request payload
        ctx.emit(
          { ...defineEventa(`${event.receiveEvent.id}-${payload.body.invokeId}`), invokeType: event.receiveEvent.invokeType } as ReceiveEvent<ExtendableInvokeResponse<Res, InvocableEventContext<CtxExt, EOpts>>>,
          { ...payload.body, content: response },
          options,
        ) // emit: event_response
      }
      catch (error) {
        // TODO: to error object
        ctx.emit(
          { ...defineEventa(`${event.receiveEventError.id}-${payload.body.invokeId}`), invokeType: event.receiveEventError.invokeType } as ReceiveEventError<Res, Req, ResErr, ReqErr>,
          { ...payload.body, content: { error: error as ResErr } },
          options,
        )
      }
    }

    handlers.set(handler, internalHandler)
    ctx.on(event.sendEvent, internalHandler)
  }

  return () => ctx.off(event.sendEvent, internalHandler)
}

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
 * Remove one or all invoke handlers for a specific invoke event.
 *
 * @param ctx The event context from which to remove the invoke handler(s).
 * @param event The invoke event whose handlers are to be removed.
 * @param handler The specific handler to remove. If not omitted, all handlers for the event will be removed.
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

    ctx.off(event.sendEvent, internalHandler)
    ctx.invokeHandlers.delete(event.sendEvent.id)
    return true
  }

  let returnValue = false
  for (const internalHandlers of handlers.values()) {
    ctx.off(event.sendEvent, internalHandlers)
    returnValue = true
  }
  ctx.invokeHandlers.delete(event.sendEvent.id)
  return returnValue
}
