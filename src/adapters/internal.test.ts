import type { EventaInner } from '../internal'

import { describe, expect, it } from 'vitest'

import { EventaType } from '../eventa'
import { setEventaInner } from '../internal'
import { createOutboundInner, restoreInner } from './internal'

describe('adapter inner contract', () => {
  it('restores a valid inner value as inbound Eventa', () => {
    const inner = {
      deliveryId: 'adapter-contract-delivery',
      hopsRemaining: 7,
      eventa: { id: 'adapter:contract', type: EventaType.Event, body: { value: 1 } },
    } satisfies EventaInner<{ value: number }>

    const restored = restoreInner(inner)

    expect(restored.eventa).toMatchObject({ ...inner.eventa, _flowDirection: 'inbound' })
  })

  it('rejects malformed values before they reach an adapter context', () => {
    const malformed = { deliveryId: 'missing-hop-budget', eventa: { id: 'adapter:contract' } }

    expect(() => restoreInner(malformed)).toThrowError('Invalid EventaInner.')
  })

  it('creates an outbound wire value from a dispatched Eventa', () => {
    const inner = {
      deliveryId: 'adapter-outbound-delivery',
      hopsRemaining: 3,
      eventa: { id: 'adapter:outbound', type: EventaType.Event, body: { value: 1 } },
    } satisfies EventaInner<{ value: number }>
    setEventaInner(inner.eventa, inner)

    expect(createOutboundInner(inner.eventa)).toEqual({
      ...inner,
      eventa: { ...inner.eventa, _flowDirection: 'outbound' },
    })
  })
})
