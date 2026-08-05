import type { EventaInner } from '../../internal'

import { restoreInner as restoreAdapterInner } from '../internal'
import { isWorkerEventa, normalizeOnListenerParameters } from './shared'

/**
 * Creates the worker wire value without mutating the context-owned inner value.
 * Transfer metadata is removed from the Eventa body because the worker API
 * carries the transfer list out of band in `postMessage` options.
 */
export function createWorkerInnerEventa<Transfer = Transferable>(
  inner: EventaInner,
  options?: { transfer?: Transfer[] },
): { inner: EventaInner, transfer?: Transfer[] } {
  // The worker wire body may differ from the application body, so construct a
  // new Eventa value while preserving routing identity and the original event.
  const clonedBody = typeof inner.eventa.body === 'object' && inner.eventa.body !== null
    ? { ...inner.eventa.body }
    : inner.eventa.body
  const eventa = { ...inner.eventa, body: clonedBody }
  const { body, transfer } = normalizeOnListenerParameters<Transfer>(eventa, options)
  return {
    inner: { ...inner, eventa: { ...eventa, body } },
    transfer,
  }
}

/** Restores the public worker-event body shape after transport deserialization. */
export function restoreInner(value: unknown): EventaInner {
  const inner = restoreAdapterInner(value)
  if (!isWorkerEventa(inner.eventa)) {
    return inner
  }
  return restoreAdapterInner({
    ...inner,
    eventa: { ...inner.eventa, body: { message: inner.eventa.body } },
  })
}
