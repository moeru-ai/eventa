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

  const hooks = props.adapter?.(emit).hooks

  function emit<P>(event: Eventa<P>, payload: P, options?: Options) {
    const emittingPayload = { ...event, body: payload }

    for (const listener of listeners.get(event.id) || []) {
      listener(emittingPayload, options)
      hooks?.onReceived?.(event.id, emittingPayload)
    }

    for (const onceListener of onceListeners.get(event.id) || []) {
      onceListener(emittingPayload, options)
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
          listener(emittingPayload, options)
          hooks?.onReceived?.(matchExpression.id, emittingPayload)
        }
        for (const onceListener of matchExpressionOnceListeners.get(matchExpression.id) || []) {
          onceListener(emittingPayload, options)
          hooks?.onReceived?.(matchExpression.id, emittingPayload)
          matchExpressionOnceListeners.get(matchExpression.id)?.delete(onceListener)
        }
      }
    }

    hooks?.onSent(event.id, emittingPayload, options)
  }

  return {
    get listeners() {
      return listeners
    },

    get onceListeners() {
      return onceListeners
    },

    emit,

    on<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: Options) => void): () => void {
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

    once<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: Options) => void): () => void {
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

    off<P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler?: (payload: Eventa<P>, options?: Options) => void) {
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
  }
}

export interface EventContext<Extensions = undefined, EmitOptions = undefined> {
  listeners: Map<EventTag<any, any>, Set<(params: any) => any>>
  onceListeners: Map<EventTag<any, any>, Set<(params: any) => any>>

  emit: <P>(event: Eventa<P>, payload: P, options?: EmitOptions) => void
  on: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => void) => () => void
  once: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => void) => () => void
  off: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler?: (payload: Eventa<P>, options?: EmitOptions) => void) => void

  /**
   * Extensions (adapter-specific).
   *
   * Known usage: webworkers/worker-threads populate internal invoke config via
   * `extensions.__internal.invoke` to abort pending invokes on fatal errors.
   */
  extensions?: Extensions
}

export type EventContextEmitFn = EventContext['emit']
