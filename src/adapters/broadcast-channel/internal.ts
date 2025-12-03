import type { EventTag } from '../..'
import type { Payload } from './shared'

import { nanoid } from '../..'

export function generatePayload<T>(type: EventTag<any, any>, payload: T): Payload<T> {
  return {
    id: nanoid(),
    type,
    payload,
  }
}

export function parsePayload<T>(data: unknown): Payload<T> {
  return data as Payload<T>
}
