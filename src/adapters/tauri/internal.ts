import type { EventTag } from '../../eventa'
import type { Payload } from './shared'

import { nanoid } from '../../eventa'

export function generatePayload<T>(type: EventTag<any, any>, payload: T): Payload<T> {
  return {
    id: nanoid(),
    type,
    payload,
  }
}

export function parsePayload<T>(data: unknown): Payload<T> {
  if (
    typeof data !== 'object'
    || data === null
    || !('type' in data)
    || typeof data.type !== 'string'
    || !('payload' in data)
    || typeof data.payload !== 'object'
    || data.payload === null
  ) {
    throw new TypeError('eventa: invalid Tauri payload')
  }

  return data as Payload<T>
}
