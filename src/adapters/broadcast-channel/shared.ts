import type { EventTag } from '../../eventa'

import { defineEventa } from '../../eventa'

export interface Payload<T> {
  id: string
  type: EventTag<any, any>
  payload: T
}

export const errorEvent = { ...defineEventa<{ error: unknown }>() }
