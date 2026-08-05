import type { Eventa } from '../eventa'
import type { EventaInner } from '../internal'

import { defineInboundEventa, defineOutboundEventa } from '../eventa'
import { getEventaInner, isEventaInner, setEventaInner } from '../internal'

/**
 * Creates the outbound transport value for an Eventa dispatched by Context.
 * Returns `undefined` after the delivery has exhausted its hop budget.
 */
export function createOutboundInner(eventa: Eventa): EventaInner | undefined {
  const inner = getEventaInner(eventa)
  if (!inner) {
    return undefined
  }
  return {
    ...inner,
    eventa: {
      ...inner.eventa,
      ...defineOutboundEventa(inner.eventa.id),
    },
  }
}

/**
 * Validates a transport value and restores its Eventa as inbound. The hidden
 * association lets the following `ctx.emit(...)` preserve the delivery ID.
 */
export function restoreInner(value: unknown): EventaInner {
  if (!isEventaInner(value)) {
    throw new TypeError('Invalid EventaInner.')
  }
  const inner: EventaInner = {
    ...value,
    eventa: {
      ...value.eventa,
      ...defineInboundEventa(value.eventa.id),
    },
  }
  setEventaInner(inner.eventa, inner)
  return inner
}
