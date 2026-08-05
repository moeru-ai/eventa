import type { Eventa, EventaMatchExpression, EventTag } from './eventa'
import type { EventaInner } from './internal'

import { EventaType } from './eventa'
import { createEventaInner, getEventaInner, getPreviousContext, setEventaInner } from './internal'

export interface EventContextRoutingOptions {
  /** Maximum delivery IDs retained for duplicate suppression. @default 10000 */
  recentDeliveryLimit?: number
  /** Time in milliseconds that a delivery ID remains known. @default 300000 */
  recentDeliveryTtl?: number
  /** Hop budget assigned to each local emit. @default 32 */
  initialHops?: number
  /** Receives non-routable observations about delivery routing. */
  onDiagnostic?: (diagnostic: EventContextRoutingDiagnostic) => void
}

/** A local routing observation that is never forwarded as an Eventa. */
export interface EventContextRoutingDiagnostic {
  readonly kind: 'hops-exhausted'
  readonly inner: Readonly<EventaInner>
}

export interface CreateContextOptions {
  /** Delivery routing policy owned by this context. */
  routing?: EventContextRoutingOptions
}

const defaultRoutingOptions: Required<Omit<EventContextRoutingOptions, 'onDiagnostic'>> = {
  recentDeliveryLimit: 10_000,
  recentDeliveryTtl: 5 * 60 * 1_000,
  initialHops: 32,
}

function resolveRoutingOptions(options?: EventContextRoutingOptions) {
  const resolved = { ...defaultRoutingOptions, ...options }
  if (!Number.isSafeInteger(resolved.recentDeliveryLimit) || resolved.recentDeliveryLimit < 1) {
    throw new RangeError('recentDeliveryLimit must be a positive safe integer.')
  }
  if (!Number.isFinite(resolved.recentDeliveryTtl) || resolved.recentDeliveryTtl <= 0) {
    throw new RangeError('recentDeliveryTtl must be a positive finite number.')
  }
  if (!Number.isSafeInteger(resolved.initialHops) || resolved.initialHops < 0) {
    throw new RangeError('initialHops must be a non-negative safe integer.')
  }

  return resolved
}

/**
 * Creates an Eventa subscription and routing context.
 *
 * The context associates one delivery identity with each emitted Eventa before
 * dispatch. Forwarding listeners preserve that identity when they emit into
 * another Context. Recent IDs are bounded by both retention time and capacity;
 * concurrent emit calls are intentionally unordered.
 */
export function createContext<Extensions = undefined, Options = { raw?: unknown }>(options: CreateContextOptions = {}): EventContext<Extensions, Options> {
  const listeners = new Map<EventTag<any, any>, Set<(params: any, options?: Options) => any>>()
  const onceListeners = new Map<EventTag<any, any>, Set<(params: any, options?: Options) => any>>()

  const matchExpressions = new Map<string, EventaMatchExpression<any>>()
  const matchExpressionListeners = new Map<string, Set<(params: any, options?: Options) => any>>()
  const matchExpressionOnceListeners = new Map<string, Set<(params: any, options?: Options) => any>>()

  // Adapters abort this lifetime when their transport dies. Invoke operations
  // observe the signal so all pending calls reject instead of waiting forever.
  // A linked context owns a separate lifetime and is never aborted implicitly.
  const lifetimeController = new AbortController()
  const recentDeliveries = new Map<string, number>()
  const routingOptions = resolveRoutingOptions(options.routing)

  function hasSeen(deliveryId: string): boolean {
    const now = Date.now()

    for (const [knownDeliveryId, expiresAt] of recentDeliveries) {
      if (expiresAt > now) {
        break
      }
      recentDeliveries.delete(knownDeliveryId)
    }

    const expiresAt = recentDeliveries.get(deliveryId)
    if (typeof expiresAt === 'number' && expiresAt > now) {
      return true
    }

    recentDeliveries.delete(deliveryId)
    recentDeliveries.set(deliveryId, now + routingOptions.recentDeliveryTtl)

    while (recentDeliveries.size > routingOptions.recentDeliveryLimit) {
      const oldestDeliveryId = recentDeliveries.keys().next().value
      if (typeof oldestDeliveryId !== 'string') {
        break
      }
      recentDeliveries.delete(oldestDeliveryId)
    }

    return false
  }

  function dispatch<Payload>(event: Eventa<Payload>, localOptions?: Options): Promise<void> {
    const pending: Array<Promise<void>> = []

    function track(result: unknown | Promise<unknown>) {
      if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') {
        pending.push(result as Promise<void>)
      }
    }

    function call(listener: (params: Eventa<Payload>, options?: Options) => unknown) {
      try {
        track(listener(event, localOptions))
      }
      catch (error) {
        pending.push(Promise.reject(error))
      }
    }

    for (const listener of listeners.get(event.id) || []) {
      call(listener)
    }

    for (const onceListener of onceListeners.get(event.id) || []) {
      call(onceListener)
      onceListeners.get(event.id)?.delete(onceListener)
    }

    for (const matchExpression of matchExpressions.values()) {
      if (!matchExpression.matcher || !matchExpression.matcher(event)) {
        continue
      }

      for (const listener of matchExpressionListeners.get(matchExpression.id) || []) {
        call(listener)
      }
      for (const onceListener of matchExpressionOnceListeners.get(matchExpression.id) || []) {
        call(onceListener)
        matchExpressionOnceListeners.get(matchExpression.id)?.delete(onceListener)
      }
    }

    return Promise.all(pending).then(() => void 0)
  }

  function accept(inner: EventaInner, localOptions?: Options, previousContext?: object): Promise<void> {
    if (hasSeen(inner.deliveryId)) {
      return Promise.resolve()
    }

    const pending: Promise<void>[] = []
    if (inner.hopsRemaining === 0) {
      try {
        routingOptions.onDiagnostic?.({ kind: 'hops-exhausted', inner })
      }
      catch (error) {
        pending.push(Promise.reject(error))
      }
    }
    else {
      setEventaInner(inner.eventa, {
        ...inner,
        hopsRemaining: inner.hopsRemaining - 1,
      }, previousContext)
    }

    pending.push(dispatch(inner.eventa, localOptions))
    return Promise.all(pending).then(() => void 0)
  }

  function emit<P>(event: Eventa<P>, payload: P, localOptions?: Options): Promise<void> {
    const emittedEvent = { ...event, body: payload }
    const existingInner = getEventaInner(event)
    const previousContext = getPreviousContext(event)
    const inner = existingInner
      ? { ...existingInner, eventa: emittedEvent }
      : createEventaInner(emittedEvent, routingOptions.initialHops)
    return accept(inner, localOptions, previousContext)
  }

  const context: EventContext<Extensions, Options> = {
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
        matchExpressions.set(matchExpression.id, matchExpression)
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
        matchExpressions.set(matchExpression.id, matchExpression)
        if (!matchExpressionOnceListeners.has(matchExpression.id)) {
          matchExpressionOnceListeners.set(matchExpression.id, new Set())
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
      // AbortController retains the first reason, making repeated teardown safe.
      if (!lifetimeController.signal.aborted) {
        lifetimeController.abort(reason)
      }
    },
  }

  return context
}

export interface EventContext<Extensions = undefined, EmitOptions = undefined> {
  listeners: Map<EventTag<any, any>, Set<(params: any) => any>>
  onceListeners: Map<EventTag<any, any>, Set<(params: any) => any>>

  /**
   * Dispatches and forwards one event. Concurrent calls are independent and
   * have no ordering guarantee; the promise tracks only this emitted event.
   */
  emit: <P>(event: Eventa<P>, payload: P, options?: EmitOptions) => Promise<void>
  on: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => any) => () => void
  once: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler: (payload: Eventa<P>, options?: EmitOptions) => any) => () => void
  off: <P>(eventOrMatchExpression: Eventa<P> | EventaMatchExpression<P>, handler?: (payload: Eventa<P>, options?: EmitOptions) => any) => void

  /**
   * Lifetime signal for this context. Transport adapters abort it when their
   * owned transport dies; linked contexts retain independent lifetimes.
   */
  signal: AbortSignal

  /**
   * Terminates this context lifetime. The first reason is retained and reaches
   * pending invokes; repeated calls are no-ops.
   */
  abort: (reason?: unknown) => void

  /** Adapter-specific capabilities attached to this context. */
  extensions?: Extensions
}

export type EventContextEmitFn = EventContext['emit']
