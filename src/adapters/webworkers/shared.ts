import type { EventContext } from '../../context'
import type { Eventa } from '../../eventa'
import type { AdapterErrorPayload } from '../errors'

import { defineEventa } from '../../eventa'
import { isExtendableInvokeResponseLike } from '../../invoke'

export type { AdapterErrorKind, AdapterErrorPayload } from '../errors'

export interface WorkerContextExtensions {
  invokeRequest?: { transfer?: Transferable[] }
  invokeResponse?: { transfer?: Transferable[] }
}

export interface WorkerEventa<T> extends Eventa<{ message: T, transfer?: Transferable[] }> {
  _workerTransfer: true
}

export function defineWorkerEventa<T>(id?: string): WorkerEventa<T> {
  return {
    ...defineEventa<{ message: T, transfer?: Transferable[] }>(id),
    _workerTransfer: true,
  }
}

export function isWorkerEventa(event: Eventa<unknown>): event is WorkerEventa<unknown> {
  return typeof event === 'object'
    && '_workerTransfer' in event
    && typeof event._workerTransfer === 'boolean'
    && event._workerTransfer === true
}

/**
 * Emitted by the worker adapters whenever a worker fails: an inbound message
 * fails to parse (`kind: 'parse'`, non-fatal), the worker hits a fatal
 * `error` (`kind: 'fatal'`), or a message can't be deserialized
 * (`kind: 'messageerror'`). Has a stable id so it can be subscribed to across
 * module boundaries.
 */
export const workerErrorEvent = defineEventa<AdapterErrorPayload>('eventa:worker:error')

export function normalizeOnListenerParameters<Transfer = Transferable>(event: Eventa<unknown>, options?: { transfer?: Transfer[] } | unknown) {
  let eventPayload: unknown = event.body
  let transfer: Transfer[] | undefined

  if (isExtendableInvokeResponseLike<unknown, EventContext<{ invokeResponse?: { transfer?: Transferable[] } }>>(event)) {
    if (event.body!.content.invokeResponse?.transfer != null) {
      transfer = event.body!.content.invokeResponse!.transfer as Transfer[]
    }

    eventPayload = { ...event.body, content: event.body!.content.response }
  }
  else if (isWorkerEventa(event)) {
    transfer = event.body?.transfer as Transfer[] | undefined
    eventPayload = event.body?.message
  }

  // Override from options
  if (typeof options !== 'undefined' && options != null && typeof options === 'object' && 'transfer' in options) {
    if (Array.isArray(options.transfer)) {
      transfer = options.transfer
    }
  }

  return {
    body: eventPayload,
    transfer,
  }
}
