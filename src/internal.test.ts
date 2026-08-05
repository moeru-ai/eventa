import { describe, expect, it } from 'vitest'

import { defineEventa } from './eventa'
import { createEventaInner, isEventaInner } from './internal'

describe('eventaInner', () => {
  it('creates an inner value with routing identity and hop budget', () => {
    const eventa = { ...defineEventa<string>('delivery:test'), body: 'hello' }
    const inner = createEventaInner(eventa, 8)

    expect(inner).toEqual({
      deliveryId: expect.any(String),
      hopsRemaining: 8,
      eventa,
    })
  })

  it('strictly rejects legacy and malformed transport values', () => {
    expect(isEventaInner({
      id: 'legacy-id',
      type: 'delivery:test',
      payload: { id: 'delivery:test', body: 'hello' },
    })).toBe(false)
    expect(isEventaInner({
      deliveryId: 'delivery-id',
      hopsRemaining: -1,
      eventa: { id: 'delivery:test' },
    })).toBe(false)
    expect(isEventaInner({
      deliveryId: 'delivery-id',
      hopsRemaining: 1,
      eventa: { id: 'delivery:test' },
    })).toBe(true)
  })
})
