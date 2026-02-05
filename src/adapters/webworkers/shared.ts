import type { EventContext } from '../../context'
import type { Eventa, EventTag } from '../../eventa'

import { defineEventa, defineOutboundEventa } from '../../eventa'
import { isExtendableInvokeResponseLike } from '../../invoke'

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

export const workerErrorEvent = defineEventa<{ error: unknown }>()
export const workerMessageErrorEvent = defineEventa<{ error: unknown, message: any }>()

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
