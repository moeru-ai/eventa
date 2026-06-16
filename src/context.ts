import type { EventaAdapter } from './context-hooks'
import type { Eventa, EventaMatchExpression, EventTag } from './eventa'

import { EventaType } from './eventa'

interface CreateContextProps<EmitOptions = any> {
  adapter?: EventaAdapter<EmitOptions>
}

export function createContext<Extensions = any, Options = { raw?: any }>(props: CreateContextProps<Options> = {}): EventContext<Extensions, Options> {
  const listeners = new Map<EventTag<any, any>, Set<(params: any, options?: Options) => any>>()
  const onceListeners = new Map<EventTag<any, any>, Set<(params: any, options?: Options) => any>>()

  const matchExpressions = new Map<string, EventaMatchExpression<any>>()
  const matchExpressionListeners = new Map<string, Set<(params: any, options?: Options) => any>>()
  const matchExpressionOnceListeners = new Map<string, Set<(params: any, options?: Options) => any>>()

  // Lifetime AbortController for this context. Adapters call `ctx.abort(reason)`
  // when the underlying transport dies (ws close, broadcast-channel dispose,
  // worker error, etc). `defineInvoke` hooks `ctx.signal` so every in-flight
  // invoke promise rejects in one cascade. Modeled after Go's context.Context:
  // a single cancellation signal that flows to every operation derived from it.
  const lifetimeController = new AbortController()

  const hooks = props.adapter?.(emit).hooks

  function emit<P>(event: Eventa<P>, payload: P, options?: Options): Promise<void> {
    const emittingPayload = { ...event, body: payload }
    const pending: Array<Promise<void>> = []

    function track(result: unknown | Promise<unknown>) {
      if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
        pending.push(result as unknown as Promise<void>)
      }
    }

    for (const listener of listeners.get(event.id) || []) {
      track(listener(emittingPayload, options))
      hooks?.onReceived?.(event.id, emittingPayload)
    }

    for (const onceListener of onceListeners.get(event.id) || []) {
      track(onceListener(emittingPayload, options))
      hooks?.onReceived?.(event.id, emittingPayload)
      onceListeners.get(event.id)?.delete(onceListener)
    }

    for (const matchExpression of matchExpressions.values()) {
      if (matchExpression.matcher) {
        const match = matchExpression.matcher(emittingPayload)
        if (!match) {
          continue
        }

        for (const listener of matchExpressionListeners.get(matchExpression.id) || []) {
          track(listener(emittingPayload, options))
          hooks?.onReceived?.(matchExpression.id, emittingPayload)
        }
        for (const onceListener of matchExpressionOnceListeners.get(matchExpression.id) || []) {
          track(onceListener(emittingPayload, options))
          hooks?.onReceived?.(matchExpression.id, emittingPayload)
          matchExpressionOnceListeners.get(matchExpression.id)?.delete(onceListener)
        }
      }
    }

    hooks?.onSent(event.id, emittingPayload, options)

    return Promise.all(pending).then(() => void 0)
  }

  return {
    get listeners() {
      return listeners
    },

    get onceListeners() {
      return onceListeners
    },

    emit,

    on<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: Options) => any): () => void {
      if (eventOrMatchExpression.type === EventaType.Event) {
        const event = eventOrMatchExpression as Eventa<P>
        if (!listeners.has(event.id)) {
          listeners.set(event.id, new Set())
        }

        listeners.get(event.id)?.add(handler)

        return () => listeners.get(event.id)?.delete(handler)
      }

      if (eventOrMatchExpression.type === EventaType.MatchExpression) {
        const matchExpression = eventOrMatchExpression as EventaMatchExpression<P>
        if (!matchExpressions.has(matchExpression.id)) {
          matchExpressions.set(matchExpression.id, matchExpression as EventaMatchExpression<P>)
        }
        if (!matchExpressionListeners.has(matchExpression.id)) {
          matchExpressionListeners.set(matchExpression.id, new Set())
        }

        matchExpressionListeners.get(matchExpression.id)?.add(handler)

        return () => matchExpressionListeners.get(matchExpression.id)?.delete(handler)
      }

      return () => void 0
    },

    once<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: Options) => any): () => void {
      if (eventOrMatchExpression.type === EventaType.Event) {
        const event = eventOrMatchExpression as Eventa<P>
        if (!onceListeners.has(event.id)) {
          onceListeners.set(event.id, new Set())
        }

        onceListeners.get(event.id)?.add(handler)

        return () => onceListeners.get(event.id)?.delete(handler)
      }

      if (eventOrMatchExpression.type === EventaType.MatchExpression) {
        const matchExpression = eventOrMatchExpression as EventaMatchExpression<P>
        if (!matchExpressions.has(matchExpression.id)) {
          matchExpressions.set(matchExpression.id, matchExpression as EventaMatchExpression<P>)
        }
        if (!matchExpressionListeners.has(matchExpression.id)) {
          matchExpressionListeners.set(matchExpression.id, new Set())
        }

        matchExpressionOnceListeners.get(matchExpression.id)?.add(handler)

        return () => matchExpressionOnceListeners.get(matchExpression.id)?.delete(handler)
      }

      return () => void 0
    },

    off<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler?: (payload: Eventa<P>, options?: Options) => any) {
      switch (eventOrMatchExpression.type) {
        case EventaType.Event:
          if (handler !== undefined) {
            listeners.get(eventOrMatchExpression.id)?.delete(handler)
            onceListeners.get(eventOrMatchExpression.id)?.delete(handler)
            break
          }

          listeners.delete(eventOrMatchExpression.id)
          onceListeners.delete(eventOrMatchExpression.id)
          break
        case EventaType.MatchExpression:
          if (handler !== undefined) {
            matchExpressionListeners.get(eventOrMatchExpression.id)?.delete(handler)
            matchExpressionOnceListeners.get(eventOrMatchExpression.id)?.delete(handler)
            break
          }

          matchExpressionListeners.delete(eventOrMatchExpression.id)
          matchExpressionOnceListeners.delete(eventOrMatchExpression.id)
          break
      }
    },

    signal: lifetimeController.signal,

    abort(reason?: unknown) {
      // Idempotent — repeated calls are no-ops, matching AbortController semantics.
      if (lifetimeController.signal.aborted) {
        return
      }

      lifetimeController.abort(reason)
    },
  }
}

export interface EventContext<Extensions = undefined, EmitOptions = undefined> {
  listeners: Map<EventTag<any, any>, Set<(params: any) => any>>
  onceListeners: Map<EventTag<any, any>, Set<(params: any) => any>>

  emit: <P>(event: Eventa<P>, payload: P, options?: EmitOptions) => Promise<void>
  on: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => any) => () => void
  once: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => any) => () => void
  off: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler?: (payload: Eventa<P>, options?: EmitOptions) => any) => void

  /**
   * Lifetime signal for this context. Aborts when `abort()` is called by an
   * adapter (e.g. ws close, broadcast-channel dispose, worker error). Every
   * `defineInvoke(...)` derived from this ctx hooks this signal so transport
   * death cascades into a single synchronous reject of every in-flight invoke.
   *
   * Mirrors Go's `context.Context` lifetime semantics: one signal, many
   * derived operations, one cancel cascades to all.
   */
  signal: AbortSignal

  /**
   * Abort this context's lifetime signal. Adapters call this at transport-death
   * points; the `reason` flows through to `invoke()` promise rejections so
   * callers see a meaningful Error rather than a generic AbortError.
   *
   * Idempotent — repeated calls are no-ops.
   */
  abort: (reason?: unknown) => void

  /**
   * Extensions (adapter-specific).
   *
   * Known usage: webworkers/worker-threads populate internal invoke config via
   * `extensions.__internal.invoke` to abort pending invokes on fatal errors.
   */
  extensions?: Extensions
}

export type EventContextEmitFn = EventContext['emit']
