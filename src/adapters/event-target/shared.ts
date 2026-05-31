import type { EventTag } from '../../eventa'
import type { AdapterErrorPayload } from '../errors'

import { defineEventa } from '../../eventa'

export type { AdapterErrorKind, AdapterErrorPayload } from '../errors'

export interface CustomEventDetail<T> {
  id: string
  type: EventTag<any, any>
  payload: T
}

/**
 * Emitted by the EventTarget adapter when an inbound event fails to parse
 * (`kind: 'parse'`) or the underlying target dispatches an `error`
 * (`kind: 'fatal'`). This adapter is generic (it also backs WebSocket-style
 * targets), so the event is named generically rather than worker-specific.
 * Has a stable id so it can be subscribed to across module boundaries.
 */
export const adapterErrorEvent = defineEventa<AdapterErrorPayload>('eventa:adapter:error')
