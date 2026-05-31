import type { EventTag } from '../../eventa'
import type { AdapterErrorPayload } from '../errors'

import { defineEventa } from '../../eventa'

export type { AdapterErrorKind, AdapterErrorPayload } from '../errors'

export interface Payload<T> {
  id: string
  type: EventTag<any, any>
  payload: T
}

export interface WindowMessageEnvelope<T> {
  __eventa: true
  channel: string
  sourceId: string
  payload: Payload<T>
}

/**
 * Emitted by the window-message adapter when an inbound message fails to parse
 * (`kind: 'parse'`) or the window dispatches a `messageerror`
 * (`kind: 'messageerror'`). Neither is fatal — the window itself stays alive,
 * so the context is not aborted. Has a stable id so it can be subscribed to
 * across module boundaries.
 */
export const errorEvent = defineEventa<AdapterErrorPayload>('eventa:window-message:error')
