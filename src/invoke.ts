import type { EventContext } from './context'
import type { Eventa } from './eventa'
import type { InvokeEventa, InvokeHandlerEventa, ReceiveEvent, ReceiveEventError, SendEvent, SendEventAbort, SendEventError, SendEventStreamEnd } from './invoke-shared'

import { defineEventa, nanoid } from './eventa'
import { isReceiveEvent } from './invoke-shared'
import { InvokeState } from './invoke-state'
import { createAbortError, isAsyncIterable, isReadableStream } from './utils'

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

export type ExtractInvokeRequestOptions<EC extends EventContext<any, any>>
  = EC extends EventContext<infer E, any>
    ? E extends { invokeRequest: infer IR }
      ? IR & { signal?: AbortSignal }
      : E extends { invokeRequest?: infer IR }
        ? IR & { signal?: AbortSignal }
        : { signal?: AbortSignal }
    : { signal?: AbortSignal }

export type ExtractInvokeResponseOptions<EC extends EventContext<any, any>>
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
      ? (req?: Req, options?: ExtractInvokeRequestOptions<EC>) => Promise<Res>
      : (req: Req, options: ExtractInvokeRequestOptions<EC>) => Promise<Res>
    : IsInvokeRequestOptional<EC> extends true
      ? (req: Req, options?: ExtractInvokeRequestOptions<EC>) => Promise<Res>
      : (req: Req, options: ExtractInvokeRequestOptions<EC>) => Promise<Res>

export type InvokeFunctionMap<EventMap extends Record<string, InvokeEventa<any, any, any, any>>, EC extends EventContext<any, any>> = {
  [K in keyof EventMap]: EventMap[K] extends InvokeEventa<infer Res, infer Req, any, any> ? InvokeFunction<Res, Req, EC> : never
}

export type ExtendableInvokeResponse<Res, EC extends EventContext<any, any>>
  = | Promise<Res>
    | Res
    | Promise<{ response: Res, invokeResponse?: ExtractInvokeResponseOptions<EC> }>
    | { response: Res, invokeResponse?: ExtractInvokeResponseOptions<EC> }

export function isExtendableInvokeResponseLike<Res, EC extends EventContext<any, any>>(value: Eventa<unknown> | ReceiveEvent<{ response: Res, invokeResponse?: unknown }>): value is ReceiveEvent<{ response: Res, invokeResponse?: ExtractInvokeResponseOptions<EC> }> {
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
    abortController?: AbortController
  } & RawEventOptions,
) => ExtendableInvokeResponse<Res, EC>

interface InternalInvokeHandler<
  Res,
  Req = any,
  ResErr = Error,
  ReqErr = Error,
  EO = any,
  M = undefined,
  IM = undefined,
> {
  onSend: (params: Eventa<NonNullable<InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>['sendEvent']['body']>>, eventOptions?: EO) => void
  onSendError: (params: Eventa<NonNullable<InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>['sendEventError']['body']>>, eventOptions?: EO) => void
  onSendStreamEnd: (params: Eventa<NonNullable<InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>['sendEventStreamEnd']['body']>>, eventOptions?: EO) => void
  onSendAbort: (params: Eventa<NonNullable<InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>['sendEventAbort']['body']>>, eventOptions?: EO) => void
  cleanup: () => void
}

export type HandlerMap<
  EventMap extends Record<string, InvokeEventa<any, any, any, any, any, any>>,
  EO = any,
  EC extends EventContext<any, any> = EventContext<any, any>,
> = {
  [K in keyof EventMap]: EventMap[K] extends InvokeEventa<infer Res, infer Req, any, any, any, any>
    ? Handler<Res, Req, EC, EO>
    : never
}

export interface InvocableEventContext<E, EO> extends EventContext<E, EO> {
  invokeHandlers?: Map<string, Map<Handler<any, any, any, any>, InternalInvokeHandler<any, any, any, any, any, any, any>>>
}

/**
 * Create a unary invoke function (client side).
 *
 * It supports unary or streaming requests, but returns a single response.
 * Use `defineStreamInvoke` when you expect a stream of responses.
 * Streaming request chunks are ordered within this invocation even though the
 * underlying context does not order independent emits.
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
  M = undefined,
  IM = undefined,
  CtxExt = any,
  EOpts = any,
  ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
>(ctx: ECtx | (() => ECtx | Promise<ECtx>), event: InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>): InvokeFunction<Res, Req, ECtx> {
  function getContext(): ECtx | Promise<ECtx> {
    if (typeof ctx === 'function') {
      return ctx()
    }

    return ctx
  }

  function createInvokePromise(resolvedCtx: ECtx, req?: Req, options?: ExtractInvokeRequestOptions<ECtx>): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const ctx = resolvedCtx
      const invokeId = nanoid()

      const invokeReceiveEvent = defineEventa(`${event.receiveEvent.id}-${invokeId}`) as ReceiveEvent<Res, Req, ResErr, ReqErr, M, IM>
      delete invokeReceiveEvent.metadata
      const invokeReceiveEventError = defineEventa(`${event.receiveEventError.id}-${invokeId}`) as ReceiveEventError<Res, Req, ResErr, ReqErr, M, IM>
      delete invokeReceiveEventError.metadata

      const { signal, ...emitOptions } = (options ?? {}) as ExtractInvokeRequestOptions<ECtx> & Record<string, unknown>
      const requestEmitOptions = emitOptions as EOpts
      let finished = false

      const onAbort = () => {
        void ctx.emit(event.sendEventAbort, { invokeId, content: signal?.reason }, requestEmitOptions).catch(() => void 0)
        // eslint-disable-next-line ts/no-use-before-define
        finishReject(createAbortError(signal?.reason))
      }

      // Hook ctx.signal so transport-death (ws close, worker error,
      // broadcast-channel dispose, etc) cascades into a synchronous reject
      // for every in-flight invoke. The reason passed to `ctx.abort(reason)`
      // by the adapter flows straight through — we don't wrap it in
      // createAbortError because adapters produce semantically-rich errors
      // ("eventa: ws disconnected (<url>)") that callers want to see verbatim.
      const ctxSignal: AbortSignal | undefined = (ctx as { signal?: AbortSignal }).signal
      const onCtxAbort = () => {
        // eslint-disable-next-line ts/no-use-before-define
        finishReject(ctxSignal?.reason)
      }

      const cleanup = () => {
        ctx.off(invokeReceiveEvent)
        ctx.off(invokeReceiveEventError)
        if (ctxSignal) {
          ctxSignal.removeEventListener('abort', onCtxAbort)
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const finishReject = (error?: any) => {
        if (finished) {
          return
        }

        finished = true
        reject(error)
        cleanup()
      }

      const finishResolve = (value: Res) => {
        if (finished) {
          return
        }
        finished = true
        resolve(value)

        cleanup()
      }

      ctx.on(invokeReceiveEvent, (payload) => {
        if (!payload.body) {
          return
        }
        if (payload.body.invokeId !== invokeId) {
          return
        }

        const { content } = payload.body
        finishResolve(content as Res)
      })

      ctx.on(invokeReceiveEventError, (payload) => {
        if (!payload.body) {
          return
        }
        if (payload.body.invokeId !== invokeId) {
          return
        }

        const { error } = payload.body.content
        finishReject(error)
      })

      if (ctxSignal) {
        if (ctxSignal.aborted) {
          onCtxAbort()
          return
        }
        ctxSignal.addEventListener('abort', onCtxAbort, { once: true })
      }

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }

        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (!isReadableStream<Req>(req) && !isAsyncIterable<Req>(req)) {
        void ctx.emit(event.sendEvent, { invokeId, content: req as Req }, requestEmitOptions).catch(finishReject)
      }
      else {
        const sendChunk = (chunk: Req) => {
          if (finished) {
            return Promise.resolve()
          }
          return ctx.emit(event.sendEvent, { invokeId, content: chunk, isReqStream: true }, requestEmitOptions) // emit: event_trigger
        }

        const sendEnd = () => {
          if (finished) {
            return Promise.resolve()
          }
          return ctx.emit(event.sendEventStreamEnd, { invokeId, content: undefined }, requestEmitOptions) // emit: event_stream_end
        }

        const pump = async () => {
          let sending = false
          try {
            // Context emits are unordered across calls. Await each frame here so
            // this invocation's chunks cannot be overtaken by its end frame.
            for await (const chunk of req) {
              // If aborted already, no further emits
              if (signal?.aborted) {
                return
              }

              sending = true
              await sendChunk(chunk)
              sending = false
              if (finished) {
                return
              }
            }

            if (finished) {
              return
            }
            sending = true
            await sendEnd()
          }
          catch (error) {
            if (sending) {
              // A partial request may already exist remotely. Abort it as a
              // best-effort cleanup, but reject locally with the send failure.
              void ctx.emit(event.sendEventAbort, { invokeId, content: error }, requestEmitOptions).catch(() => void 0)
            }
            else {
              // Request-source failures are protocol data, distinct from
              // cancellation. Await the error frame to preserve frame order.
              finishReject(error)
              try {
                await ctx.emit(event.sendEventError, { invokeId, content: error as ReqErr }, requestEmitOptions)
              }
              catch (publishError) {
                // The error frame may follow partial request data. If publishing
                // it fails, try to terminate that remote request explicitly.
                void ctx.emit(event.sendEventAbort, { invokeId, content: publishError }, requestEmitOptions).catch(() => void 0)
              }
            }
            if (sending) {
              finishReject(error)
            }
          }
        }

        pump()
      }
    })
  }

  function _invoke(req?: Req, options?: ExtractInvokeRequestOptions<ECtx>): Promise<Res> {
    const resolvedCtx = getContext()
    if (resolvedCtx instanceof Promise) {
      return resolvedCtx.then(ctx => createInvokePromise(ctx, req, options))
    }

    return createInvokePromise(resolvedCtx, req, options)
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
  EventMap extends Record<EK, InvokeEventa<any, any, any, any, any, any>>,
  CtxExt = any,
  EOpts = any,
  ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
>(ctx: ECtx | (() => ECtx | Promise<ECtx>), events: EventMap): InvokeFunctionMap<EventMap, ECtx> {
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
 * Triggering workflow:
 *
 * {@link defineInvoke}
 *   -> {@link EventContext.on}
 *     -> `sendEvent` / `sendEventError` / `sendEventStreamEnd` / `sendEventAbort`
 *       -> {@link defineInvokeHandler}
 *
 * Upstream:
 * - {@link defineInvoke}
 *
 * Downstream:
 * - {@link EventContext.emit}
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
 * @returns A disposer that removes protocol listeners and registry ownership. Active handlers keep running; their request streams and abort controllers remain valid until those handlers settle.
 */
export function defineInvokeHandler<
  Res,
  Req = undefined,
  ResErr = Error,
  ReqErr = Error,
  M = undefined,
  IM = undefined,
  CtxExt = any,
  EOpts extends { raw?: any } = any,
>(
  ctx: InvocableEventContext<CtxExt, EOpts>,
  event: InvokeHandlerEventa<Res, Req, ResErr, ReqErr, M, IM>,
  handler: Handler<Res, Req, InvocableEventContext<CtxExt, EOpts>, EOpts>,
): () => void {
  if (!ctx.invokeHandlers) {
    ctx.invokeHandlers = new Map()
  }
  const handlerRegistry = ctx.invokeHandlers

  let registeredHandlers = handlerRegistry.get(event.sendEvent.id)
  if (!registeredHandlers) {
    registeredHandlers = new Map()
    handlerRegistry.set(event.sendEvent.id, registeredHandlers)
  }
  const handlers = registeredHandlers

  function removeHandler(internalHandler: InternalInvokeHandler<Res, Req, ResErr, ReqErr, EOpts, M, IM>) {
    ctx.off(event.sendEvent, internalHandler.onSend)
    ctx.off(event.sendEventError, internalHandler.onSendError)
    ctx.off(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
    ctx.off(event.sendEventAbort, internalHandler.onSendAbort)
    internalHandler.cleanup()
    handlers.delete(handler)
    if (handlers.size === 0 && handlerRegistry.get(event.sendEvent.id) === handlers) {
      handlerRegistry.delete(event.sendEvent.id)
    }
  }

  const existingHandler = handlers.get(handler) as InternalInvokeHandler<Res, Req, ResErr, ReqErr, EOpts, M, IM> | undefined
  if (existingHandler) {
    return () => removeHandler(existingHandler)
  }

  const requestState = new InvokeState<Req>(ctx.signal)

  const handleInvoke = async (invokeId: string, payload: Req, options?: EOpts) => {
    const abortController = requestState.materialize(invokeId)

    const handlerOptions = options
      ? { ...options, abortController }
      : ({ abortController } as EOpts & { abortController: AbortController })

    try {
      const response = await handler(payload as Req, handlerOptions) // Call the handler function with the request payload
      await ctx.emit(
        { ...defineEventa(`${event.receiveEvent.id}-${invokeId}`), invokeType: event.receiveEvent.invokeType } as ReceiveEvent<ExtendableInvokeResponse<Res, InvocableEventContext<CtxExt, EOpts>>, M, IM>,
        { invokeId, content: response },
        options,
      ) // emit: event_response
    }
    catch (error) {
      // TODO: to error object
      try {
        await ctx.emit(
          { ...defineEventa(`${event.receiveEventError.id}-${invokeId}`), invokeType: event.receiveEventError.invokeType } as ReceiveEventError<Res, Req, ResErr, ReqErr, M, IM>,
          { invokeId, content: { error: error as ResErr } },
          options,
        )
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

  const onSend = async (payload: Eventa<NonNullable<SendEvent<Res, Req, ResErr, ReqErr, M, IM>['body']>>, options?: EOpts) => { // on: event_trigger
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
        // TODO: perhaps, can we correctly write type Req here?
        handleInvoke(invokeId, stream as Req, options)
      }
      requestState.pushRequestChunk(invokeId, controller, payload.body.content as Req)
      return
    }

    handleInvoke(invokeId, payload.body?.content as Req, options)
  }

  const onSendStreamEnd = (payload: Eventa<NonNullable<SendEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>['body']>>, options?: EOpts) => { // on: event_stream_end
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
      // TODO: perhaps, can we correctly write type Req here?
      handleInvoke(invokeId, stream as Req, options)
    }
    requestState.endRequestStream(invokeId, controller)
  }

  const onSendError = (payload: Eventa<NonNullable<SendEventError<Res, Req, ResErr, ReqErr, M, IM>['body']>>, options?: EOpts) => {
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
  }

  const onSendAbort = (payload: Eventa<NonNullable<SendEventAbort<Res, Req, ResErr, ReqErr, M, IM>['body']>>, _options?: EOpts) => { // on: event_abort
    if (!payload.body) {
      return
    }
    if (!payload.body.invokeId) {
      return
    }

    const invokeId = payload.body.invokeId
    requestState.rememberAbort(invokeId, payload.body.content)
  }

  const cleanup = () => {
    requestState.dispose()
  }

  const internalHandler = { onSend, onSendError, onSendStreamEnd, onSendAbort, cleanup }
  handlers.set(handler, internalHandler)

  ctx.on(event.sendEvent, internalHandler.onSend)
  ctx.on(event.sendEventError, internalHandler.onSendError)
  ctx.on(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
  ctx.on(event.sendEventAbort, internalHandler.onSendAbort)

  return () => removeHandler(internalHandler)
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
  if (!ctx.invokeHandlers) {
    return false
  }

  const handlers = ctx.invokeHandlers?.get(event.sendEvent.id)
  if (!handlers) {
    return false
  }

  if (handler) {
    const internalHandler = handlers.get(handler)
    if (!internalHandler)
      return false

    ctx.off(event.sendEvent, internalHandler.onSend)
    ctx.off(event.sendEventError, internalHandler.onSendError)
    ctx.off(event.sendEventStreamEnd, internalHandler.onSendStreamEnd)
    ctx.off(event.sendEventAbort, internalHandler.onSendAbort)
    internalHandler.cleanup()
    handlers.delete(handler)
    if (handlers.size === 0) {
      ctx.invokeHandlers.delete(event.sendEvent.id)
    }

    return true
  }

  let returnValue = false

  for (const internalHandlers of handlers.values()) {
    ctx.off(event.sendEvent, internalHandlers.onSend)
    ctx.off(event.sendEventError, internalHandlers.onSendError)
    ctx.off(event.sendEventStreamEnd, internalHandlers.onSendStreamEnd)
    ctx.off(event.sendEventAbort, internalHandlers.onSendAbort)
    internalHandlers.cleanup()
    returnValue = true
  }

  ctx.invokeHandlers.delete(event.sendEvent.id)

  return returnValue
}
