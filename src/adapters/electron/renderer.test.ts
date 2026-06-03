/// <reference types="vitest" />
/// <reference types="vite/client" />

import type { IpcRenderer } from '@electron-toolkit/preload'
import type { IpcRendererEvent } from 'electron'
import type { Mock } from 'vitest'

import type { Eventa } from '../../eventa'

import { describe, expect, it, vi } from 'vitest'

import { defineEventa, defineInboundEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggeredOnce } from '../../utils'
import { createContext } from './renderer'

describe('electron/renderer', async () => {
  it('context should be able to on and emit events', async () => {
    const ipcRenderer = {
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
    } as unknown as IpcRenderer

    const eventa = defineEventa<{ message: string }>()
    const { context: ctx } = createContext(ipcRenderer)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((
      event: Eventa,
      options?: { raw: { ipcRendererEvent: IpcRendererEvent, event: unknown } },
    ) => ({ eventa: event, options }))

    ctx.on(eventa, wrapper)
    ctx.emit(defineInboundEventa(eventa.id), { message: 'Hello, Event Target!' }, { raw: { ipcRendererEvent: {} as IpcRendererEvent, event: { message: 'Hello, Event Target!' } } }) // emit: event_trigger
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ message: 'Hello, Event Target!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options!.raw).toBeDefined()
    expect(event.options!.raw).toBeTypeOf('object')
    expect(event.options!.raw).toHaveProperty('ipcRendererEvent')
    expect(event.options!.raw).toHaveProperty('event')

    const onMocked = ipcRenderer.on as Mock
    expect(onMocked).toHaveBeenCalledTimes(2)
    expect(onMocked).toHaveBeenCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toHaveBeenCalledWith('eventa-error', expect.any(Function))

    const sendMocked = ipcRenderer.send as Mock
    ctx.emit(eventa, { message: 'Hello, Eventa!' }) // emit: eventa
    expect(sendMocked).toHaveBeenCalledTimes(1)
    expect(sendMocked.mock.calls[0][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body).toEqual({ message: 'Hello, Eventa!' })
  })

  it('should be able to invoke', async () => {
    const ipcRenderer = {
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
    } as unknown as IpcRenderer

    const { context: ctx } = createContext(ipcRenderer)

    const events = defineInvokeEventa<Promise<{ output: string }>, { input: number }>()
    const input = defineInvoke(ctx, events)

    defineInvokeHandler(ctx, events, async (payload) => {
      return { output: String(payload.input) }
    })

    const res = await input({ input: 100 })
    expect(res.output).toEqual('100')

    const onMocked = ipcRenderer.on as Mock
    expect(onMocked).toHaveBeenCalledTimes(2)
    expect(onMocked).toHaveBeenCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toHaveBeenCalledWith('eventa-error', expect.any(Function))

    const sendMocked = ipcRenderer.send as Mock
    // NOTICE: though in real world there is no chance the .send(...) could be
    // called twice inside a transport of a single invoke(...) call,
    // we will simplify the scenario here for testing purpose, as well as
    // in purpose of testing loopback / circular call of the eventa system.
    expect(sendMocked).toHaveBeenCalledTimes(2)

    // Outbound
    expect(sendMocked.mock.calls[0][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body.content).toEqual({ input: 100 })

    // Inbound
    expect(sendMocked.mock.calls[1][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[1][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[1][1].payload.body.content).toEqual({ output: '100' })
  })
})
