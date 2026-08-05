import type { Eventa } from './eventa'

import { nanoid } from './eventa'

// Delivery state belongs to the emitted Eventa object, but is intentionally
// kept out of its enumerable shape. Business listeners continue to receive an
// ordinary Eventa while forwarding listeners can preserve the delivery across
// Context, Channel, and transport boundaries.
interface EventaDispatch {
  inner: EventaInner
  previousContext?: object
}

const dispatchByEventa = new WeakMap<Eventa<unknown>, EventaDispatch>()

/**
 * One emitted Eventa occurrence travelling through a routing graph.
 *
 * Routing creates a new value when consuming hop budget. The inner identity
 * and Eventa remain stable unless an edge plugin transforms the business event.
 *
 * @template T Eventa body type carried by this routed value.
 */
export interface EventaInner<T = unknown> {
  /** Correlates one emitted occurrence across fan-out, hops, and transports. */
  readonly deliveryId: string
  /** Remaining edge crossings; a zero-hop inner value still dispatches locally. */
  readonly hopsRemaining: number
  /** Application event carried without transport-specific options. */
  readonly eventa: Eventa<T>
}

export function createEventaInner<T>(eventa: Eventa<T>, hopsRemaining: number): EventaInner<T> {
  return {
    deliveryId: nanoid(),
    hopsRemaining,
    eventa,
  }
}

/**
 * Associates forwarding state with an Eventa without changing the object shape
 * observed by business listeners or serialized by unrelated consumers.
 * `previousContext` exists only for one local Channel hop and is never sent
 * across a transport.
 */
export function setEventaInner<T>(eventa: Eventa<T>, inner: EventaInner<T>, previousContext?: object): Eventa<T> {
  dispatchByEventa.set(eventa, { inner: inner as EventaInner, previousContext })
  return eventa
}

/** Returns the forwarding state associated with one Context dispatch. */
export function getEventaInner<T>(eventa: Eventa<T>): EventaInner<T> | undefined {
  return dispatchByEventa.get(eventa)?.inner as EventaInner<T> | undefined
}

/** Returns the preceding Context for a local Channel hop, when one exists. */
export function getPreviousContext(eventa: Eventa): object | undefined {
  return dispatchByEventa.get(eventa)?.previousContext
}

/** Checks the complete transport-neutral Eventa delivery shape. */
export function isEventaInner(value: unknown): value is EventaInner {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const inner = value as Partial<EventaInner>
  return typeof inner.deliveryId === 'string'
    && inner.deliveryId.length > 0
    && Number.isSafeInteger(inner.hopsRemaining)
    && (inner.hopsRemaining ?? -1) >= 0
    && typeof inner.eventa === 'object'
    && inner.eventa !== null
    && typeof inner.eventa.id === 'string'
}
