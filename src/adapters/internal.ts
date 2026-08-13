import type { Eventa } from '../eventa'
import type { EventaInner } from '../internal'

import { defineInboundEventa, defineOutboundEventa } from '../eventa'
import { getEventaInner, isEventaInner, setEventaInner } from '../internal'

interface LegacyAdapterValue<T = unknown> {
  id: string
  type: string
  payload: Eventa<T>
  timestamp?: number
}

const legacyInitialHops = 32

function isLegacyAdapterValue(value: unknown): value is LegacyAdapterValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const legacy = value as Partial<LegacyAdapterValue>
  return typeof legacy.id === 'string'
    && legacy.id.length > 0
    && typeof legacy.type === 'string'
    && typeof legacy.payload === 'object'
    && legacy.payload !== null
    && typeof legacy.payload.id === 'string'
    && legacy.payload.id === legacy.type
}

/** Adds the beta.13 fields without changing the EventaInner fields. */
export function createAdapterInner<T>(inner: EventaInner<T>): EventaInner<T> & LegacyAdapterValue<T> {
  return {
    ...inner,
    id: inner.deliveryId,
    type: inner.eventa.id,
    payload: inner.eventa,
    timestamp: Date.now(),
  }
}

/**
 * Creates the outbound transport value for an Eventa dispatched by Context.
 * Returns `undefined` after the delivery has exhausted its hop budget.
 */
export function createOutboundInner(eventa: Eventa): (EventaInner & LegacyAdapterValue) | undefined {
  const inner = getEventaInner(eventa)
  if (!inner) {
    return undefined
  }
  return createAdapterInner({
    ...inner,
    eventa: {
      ...inner.eventa,
      ...defineOutboundEventa(inner.eventa.id),
    },
  })
}

/**
 * Validates a transport value and restores its Eventa as inbound. The hidden
 * association lets the following `ctx.emit(...)` preserve the delivery ID.
 */
export function restoreInner(value: unknown): EventaInner {
  let inner: EventaInner
  if (isEventaInner(value)) {
    inner = value
  }
  else if (isLegacyAdapterValue(value)) {
    // NOTICE:
    // beta.13 frames do not contain a hop budget. Use the historical default.
    // The adapter frame ID becomes the delivery ID for local loop suppression.
    // Source/context: https://github.com/moeru-ai/airi/actions/runs/31695542940/job/94432374039
    // Remove this branch when supported clients no longer use beta.13.
    inner = {
      deliveryId: value.id,
      hopsRemaining: legacyInitialHops,
      eventa: value.payload,
    }
  }
  else {
    throw new TypeError('Invalid EventaInner.')
  }

  const restored: EventaInner = {
    ...inner,
    eventa: {
      ...inner.eventa,
      ...defineInboundEventa(inner.eventa.id),
    },
  }
  setEventaInner(restored.eventa, restored)
  return restored
}
