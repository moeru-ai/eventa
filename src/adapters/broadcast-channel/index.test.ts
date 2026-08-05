/// <reference types="vitest" />
/// <reference types="vite/client" />

import type { Eventa } from '../../eventa'
import type { EventaInner } from '../../internal'

import { describe, expect, it } from 'vitest'

import { createContext } from '.'
import { defineEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggeredOnce } from '../../utils'

describe('broadcast channel adapter', () => {
  it('sends one EventaInner without replacing its routing identity', async () => {
    const channelName = `eventa-delivery-${crypto.randomUUID()}`
    const sender = new BroadcastChannel(channelName)
    const observer = new BroadcastChannel(channelName)
    const eventa = defineEventa<{ message: string }>('adapter:broadcast:internal')
    const { context, dispose } = createContext(sender, { closeOnDispose: true })
    const received = new Promise<EventaInner<{ message: string }>>((resolve) => {
      observer.addEventListener('message', event => resolve(event.data), { once: true })
    })

    await context.emit(eventa, { message: 'hello' })
    const delivery = await received

    expect(delivery).toMatchObject({
      deliveryId: expect.any(String),
      hopsRemaining: 31,
      eventa: { id: eventa.id, body: { message: 'hello' } },
    })

    dispose()
    observer.close()
  })

  it('context should be able to on and emit events', async () => {
    const channel = new BroadcastChannel('test')

    const eventa = defineEventa<{ msg: string }>()
    const { context: ctx } = createContext(channel)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((event: Eventa, options) => ({ eventa: event, options }))

    ctx.on(eventa, wrapper)
    const inbound = {
      deliveryId: 'broadcast-channel-inbound-delivery',
      hopsRemaining: 32,
      eventa: { ...eventa, body: { msg: 'Hello, BroadcastChannel!' } },
    } satisfies EventaInner<{ msg: string }>
    channel.dispatchEvent(new MessageEvent('message', { data: inbound }))
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ msg: 'Hello, BroadcastChannel!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options?.raw).toBeDefined()
    expect(event.options?.raw).toBeTypeOf('object')
    expect(event.options?.raw.message?.data).toBe(inbound)
  })

  it('should be able to invoke', async () => {
    const channel = new BroadcastChannel('invoke')

    const { context: ctx } = createContext(channel)

    const events = defineInvokeEventa<Promise<{ output: string }>, { input: number }>()
    const input = defineInvoke(ctx, events)

    defineInvokeHandler(ctx, events, async (payload) => {
      return { output: String(payload.input) }
    })

    const res = await input({ input: 200 })
    expect(res.output).toEqual('200')
  })
})
