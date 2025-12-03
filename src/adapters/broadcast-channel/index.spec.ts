/// <reference types="vitest" />
/// <reference types="vite/client" />

import type { Eventa } from '../../eventa'

import { describe, expect, it } from 'vitest'

import { createContext } from '.'
import { defineEventa, defineInboundEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggeredOnce } from '../../utils'

describe('broadcast channel adapter', () => {
  it('context should be able to on and emit events', async () => {
    const channel = new BroadcastChannel('test')

    const eventa = defineEventa<{ msg: string }>()
    const { context: ctx } = createContext(channel)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((event: Eventa, options) => ({ eventa: event, options }))

    ctx.on(eventa, wrapper)
    ctx.emit(
      defineInboundEventa(eventa.id),
      { msg: 'Hello, BroadcastChannel!' },
      { raw: { message: { data: { msg: 'Hello, BroadcastChannel!' } } as MessageEvent } },
    )
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ msg: 'Hello, BroadcastChannel!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options?.raw).toBeDefined()
    expect(event.options?.raw).toBeTypeOf('object')
    expect(event.options?.raw).toEqual({ message: { data: { msg: 'Hello, BroadcastChannel!' } } })
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
