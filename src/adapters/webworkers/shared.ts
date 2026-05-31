import type { EventContext } from '../../context'
import type { Eventa, EventTag } from '../../eventa'
import type { AdapterErrorPayload } from '../errors'

import { defineEventa, defineOutboundEventa } from '../../eventa'
import { isExtendableInvokeResponseLike } from '../../invoke'

export type { AdapterErrorKind, AdapterErrorPayload } from '../errors'

export interface WorkerPayload<T> {
  id: string
  type: EventTag<any, any>
  payload: T
  transfer?: Transferable[]
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

export function defineOutboundWorkerEventa<T>(id?: string): WorkerEventa<T> {
  return {
    ...defineOutboundEventa<{ message: T, transfer?: Transferable[] }>(id),
    _workerTransfer: true,
  }
}

export function isWorkerEventa(event: Eventa<any>): event is WorkerEventa<any> {
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

export function normalizeOnListenerParameters(event: Eventa<any>, options?: { transfer?: Transferable[] } | unknown) {
  let eventPayload: any = event.body
  let transfer: Transferable[] | undefined

  if (isExtendableInvokeResponseLike<unknown, EventContext<{ invokeResponse?: { transfer?: Transferable[] } }>>(event)) {
    if (event.body!.content.invokeResponse?.transfer != null) {
      transfer = event.body!.content.invokeResponse!.transfer
      delete event.body!.content.invokeResponse
    }

    eventPayload = { ...event.body, content: event.body!.content.response }
    delete eventPayload.content.response
  }
  else if (isWorkerEventa(event)) {
    transfer = event.body?.transfer
    delete event.body?.transfer

    eventPayload = event.body?.message
    delete event.body?.message
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
