import type { EventaInner } from '../internal'

import { describe, expect, it } from 'vitest'

import { EventaType } from '../eventa'
import { setEventaInner } from '../internal'
import { createOutboundInner, restoreInner } from './internal'

describe('adapter inner contract', () => {
  // https://github.com/moeru-ai/airi/actions/runs/31695542940/job/94432374039
  // ROOT CAUSE:
  //
  // EventaInner replaced the adapter envelope on the wire. A beta.13 server
  // then read `payload.body` from a frame that did not contain `payload`.
  //
  // The adapter now reads both shapes and writes the fields for both shapes.
  it('restores a beta.13 adapter value using its frame ID', () => {
    const legacy = {
      id: 'legacy-adapter-delivery',
      type: 'adapter:legacy',
      payload: {
        id: 'adapter:legacy',
        type: EventaType.Event,
        body: { value: 1 },
      },
      timestamp: 1,
    }

    const restored = restoreInner(legacy)

    expect(restored).toEqual({
      deliveryId: legacy.id,
      hopsRemaining: 32,
      eventa: { ...legacy.payload, _flowDirection: 'inbound' },
    })
  })

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

  it('creates an outbound value that beta.13 and beta.14 can read', () => {
    const inner = {
      deliveryId: 'adapter-outbound-delivery',
      hopsRemaining: 3,
      eventa: { id: 'adapter:outbound', type: EventaType.Event, body: { value: 1 } },
    } satisfies EventaInner<{ value: number }>
    setEventaInner(inner.eventa, inner)

    expect(createOutboundInner(inner.eventa)).toEqual({
      ...inner,
      eventa: { ...inner.eventa, _flowDirection: 'outbound' },
      id: inner.deliveryId,
      type: inner.eventa.id,
      payload: { ...inner.eventa, _flowDirection: 'outbound' },
      timestamp: expect.any(Number),
    })
  })
})
