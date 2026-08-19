/// <reference types="vitest" />
/// <reference types="vite/client" />

import type { Eventa } from '../../eventa'
import type { EventaInner } from '../../internal'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adapterErrorEvent, createContext } from '.'
import { defineEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggeredOnce } from '../../utils'

describe('event target', async () => {
  afterEach(() => vi.useRealTimers())

  it('context should be able to on and emit events', async () => {
    const eventTarget = new EventTarget()

    const eventa = defineEventa<{ message: string }>()
    const { context: ctx } = createContext(eventTarget)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((event: Eventa, options) => ({ eventa: event, options }))

    ctx.on(eventa, wrapper)
    const inbound = {
      deliveryId: 'event-target-inbound-delivery',
      hopsRemaining: 32,
      eventa: { ...eventa, body: { message: 'Hello, Event Target!' } },
    } satisfies EventaInner<{ message: string }>
    eventTarget.dispatchEvent(new CustomEvent('message', { detail: inbound }))
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ message: 'Hello, Event Target!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options.raw).toBeDefined()
    expect(event.options.raw).toBeTypeOf('object')
    expect(event.options.raw).toHaveProperty('event')
  })

  it('should be able to invoke', async () => {
    const eventTarget = new EventTarget()

    const { context: ctx } = createContext(eventTarget)

    const events = defineInvokeEventa<Promise<{ output: string }>, { input: number }>()
    const input = defineInvoke(ctx, events)

    defineInvokeHandler(ctx, events, async (payload) => {
      return { output: String(payload.input) }
    })

    const res = await input({ input: 100 })
    expect(res.output).toEqual('100')
  })

  it('suppresses a replay while the delivery identity is retained', async () => {
    const target = new EventTarget()
    const event = defineEventa<string>('event-target:dedupe')
    const { context } = createContext(target)
    const handler = vi.fn()
    let delivery: EventaInner | undefined

    target.addEventListener('message', (message) => {
      delivery = (message as CustomEvent<EventaInner>).detail
    })
    context.on(event, handler)
    await context.emit(event, 'hello')
    target.dispatchEvent(new CustomEvent('message', { detail: delivery }))

    expect(handler).toHaveBeenCalledOnce()
  })

  it('accepts a replay after delivery retention expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const target = new EventTarget()
    const event = defineEventa<string>('event-target:dedupe-expiry')
    const { context } = createContext(target, {
      context: { routing: { recentDeliveryTtl: 10 } },
    })
    const handler = vi.fn()
    let delivery: EventaInner | undefined

    target.addEventListener('message', (message) => {
      delivery = (message as CustomEvent<EventaInner>).detail
    })
    context.on(event, handler)
    await context.emit(event, 'hello')
    vi.advanceTimersByTime(11)
    target.dispatchEvent(new CustomEvent('message', { detail: delivery }))

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('accepts a replay after delivery capacity eviction', async () => {
    const target = new EventTarget()
    const event = defineEventa<string>('event-target:dedupe-capacity')
    const { context } = createContext(target, {
      context: { routing: { recentDeliveryLimit: 1 } },
    })
    const handler = vi.fn()
    const deliveries: EventaInner[] = []

    target.addEventListener('message', (message) => {
      deliveries.push((message as CustomEvent<EventaInner>).detail)
    })
    context.on(event, handler)
    await context.emit(event, 'first')
    await context.emit(event, 'second')
    target.dispatchEvent(new CustomEvent('message', { detail: deliveries[0] }))

    expect(handler).toHaveBeenCalledTimes(3)
    expect(handler.mock.calls[2][0].body).toBe('first')
  })

  it('reports each malformed frame without repeating the diagnostic output', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const target = new EventTarget()
    const { context } = createContext(target)
    const handler = vi.fn()
    let messageCount = 0
    target.addEventListener('message', () => messageCount++)
    context.on(adapterErrorEvent, handler)

    const malformedFrame = new CustomEvent('message', {
      detail: { id: 'legacy', payload: { id: 'event' } },
    })
    target.dispatchEvent(malformedFrame)
    target.dispatchEvent(malformedFrame)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[0][0].body).toMatchObject({
      kind: 'parse',
      error: expect.any(TypeError),
    })
    expect(messageCount).toBe(4)
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  // ROOT CAUSE:
  //
  // Context converts synchronous listener failures into rejected emit promises.
  // A transport callback cannot return that promise to EventTarget, so ignoring
  // it leaked an unhandled rejection from otherwise valid inbound messages.
  // The adapter now observes and reports the rejected emit promise.
  it('reports a listener failure from transport ingress', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const target = new EventTarget()
    const { context } = createContext(target)
    const event = defineEventa<string>('event-target:listener-failure')
    const failure = new Error('listener failed')
    context.on(event, () => {
      throw failure
    })

    target.dispatchEvent(new CustomEvent('message', {
      detail: {
        deliveryId: 'event-target-listener-failure',
        hopsRemaining: 3,
        eventa: { id: event.id, type: event.type, body: 'hello' },
      },
    }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(consoleError).toHaveBeenCalledWith('Failed to emit EventTarget message:', failure)
    consoleError.mockRestore()
  })
})
