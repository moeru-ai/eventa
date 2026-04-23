import type { EventTag } from '../../eventa'

import { defineEventa } from '../../eventa'

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

export const errorEvent = { ...defineEventa<{ error: unknown }>() }
