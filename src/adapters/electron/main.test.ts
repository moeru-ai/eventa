/// <reference types="vitest" />
/// <reference types="vite/client" />

import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'
import type { Mock } from 'vitest'

import type { Eventa } from '../../eventa'

import { describe, expect, it, vi } from 'vitest'

import { defineEventa, defineInboundEventa, defineOutboundEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggeredOnce } from '../../utils'
import { createContext } from './main'

describe('electron/main', async () => {
  it('context should be able to on and emit events', async () => {
    const ipcMain = {
      on: vi.fn(),
    } as unknown as IpcMain
    const browserWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(),
      },
    } as unknown as BrowserWindow

    const eventa = defineEventa<{ message: string }>()
    const { context: ctx } = createContext(ipcMain, browserWindow)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((event: Eventa, options) => ({ eventa: event, options }))

    // verify that the ipcMain.on is called to register listeners for inbound events
    ctx.on(eventa, wrapper)
    const onMocked = ipcMain.on as Mock
    expect(onMocked).toBeCalledTimes(2)
    expect(onMocked).toBeCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toBeCalledWith('eventa-error', expect.any(Function))

    // simulate receiving an event from ipcMain, every time we emit an inbound eventa, it will
    // emit another inbound eventa with transformed body along with raw data
    ctx.emit(defineInboundEventa(eventa.id), { message: 'Hello, Event Target!' }, { raw: { ipcMainEvent: {} as IpcMainEvent, event: { message: 'Hello, Event Target!' } } }) // emit: event_trigger
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ message: 'Hello, Event Target!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options.raw).toBeDefined()
    expect(event.options.raw).toBeTypeOf('object')
    expect(event.options.raw).toHaveProperty('ipcMainEvent')
    expect(event.options.raw).toHaveProperty('event')

    // simulate emitting an outbound eventa, it should send through the window's webContents
    ctx.emit(defineOutboundEventa(eventa.id), { message: 'Hello, outbound Eventa!' })
    // simulate emitting normal eventa (without direction), it should also send through the window's webContents too
    ctx.emit(eventa, { message: 'Hello, normal Eventa!' })

    const sendMocked = browserWindow.webContents.send as Mock
    expect(sendMocked).toBeCalledTimes(2)
    expect(sendMocked.mock.calls[0][0]).toEqual('eventa-message')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body).toEqual({ message: 'Hello, outbound Eventa!' })
    expect(sendMocked.mock.calls[1][0]).toEqual('eventa-message')
    expect(sendMocked.mock.calls[1][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[1][1].payload.body).toEqual({ message: 'Hello, normal Eventa!' })
  })

  it('context without window should be able to on and emit events through sender from raw body', async () => {
    const ipcMain = {
      on: vi.fn(),
    } as unknown as IpcMain
    const browserWindow = {
      webContents: {
        id: 1,
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      } as unknown as WebContents,
    } as unknown as BrowserWindow

    const eventa = defineEventa<{ message: string }>()
    // NOTICE: no window passed
    const { context: ctx } = createContext(ipcMain)
    const { onceTriggered, wrapper } = createUntilTriggeredOnce((event: Eventa, options) => ({ eventa: event, options }))

    // verify that the ipcMain.on is called to register listeners for inbound events
    ctx.on(eventa, wrapper)
    const onMocked = ipcMain.on as Mock
    expect(onMocked).toBeCalledTimes(2)
    expect(onMocked).toBeCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toBeCalledWith('eventa-error', expect.any(Function))

    // simulate receiving an event from ipcMain, every time we emit an inbound eventa, it will
    // emit another inbound eventa with transformed body along with raw data
    ctx.emit(defineInboundEventa(eventa.id), { message: 'Hello, Event Target!' }, { raw: { ipcMainEvent: { sender: browserWindow.webContents } as IpcMainEvent, event: { message: 'Hello, Event Target!' } } }) // emit: event_trigger
    const event = await onceTriggered
    expect(event.eventa.body).toEqual({ message: 'Hello, Event Target!' })
    expect(event.options).toBeDefined()
    expect(event.options).toBeTypeOf('object')
    expect(event.options.raw).toBeDefined()
    expect(event.options.raw).toBeTypeOf('object')
    expect(event.options.raw).toHaveProperty('ipcMainEvent')
    expect(event.options.raw).toHaveProperty('event')
    expect(event.options.raw.ipcMainEvent.sender.id).toBe(1)
    expect(event.options.raw.event).toEqual({ message: 'Hello, Event Target!' })

    // simulate emitting an outbound eventa, it should send through the window's webContents
    ctx.emit(defineOutboundEventa(eventa.id), { message: 'Hello, outbound Eventa!' }, { raw: { ipcMainEvent: { sender: browserWindow.webContents } as IpcMainEvent, event: { message: 'Hello, Event Target!' } } })
    // simulate emitting normal eventa (without direction), it should also send through the window's webContents too
    ctx.emit(eventa, { message: 'Hello, normal Eventa!' }, { raw: { ipcMainEvent: { sender: browserWindow.webContents } as IpcMainEvent, event: { message: 'Hello, Event Target!' } } })

    const sendMocked = browserWindow.webContents.send as Mock
    expect(sendMocked).toBeCalledTimes(2)
    expect(sendMocked.mock.calls[0][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body).toEqual({ message: 'Hello, outbound Eventa!' })
    expect(sendMocked.mock.calls[1][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[1][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[1][1].payload.body).toEqual({ message: 'Hello, normal Eventa!' })

    const isDestroyedMocked = browserWindow.webContents.isDestroyed as Mock
    expect(isDestroyedMocked).toBeCalledTimes(2)
  })

  it('should be able to invoke', async () => {
    const ipcMain = {
      on: vi.fn(),
    } as unknown as IpcMain
    const browserWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(),
      },
    } as unknown as BrowserWindow

    const { context: ctx } = createContext(ipcMain, browserWindow)

    const events = defineInvokeEventa<Promise<{ output: string }>, { input: number }>()
    const input = defineInvoke(ctx, events)

    defineInvokeHandler(ctx, events, async (payload) => {
      return { output: String(payload.input) }
    })

    const res = await input({ input: 100 })
    expect(res.output).toEqual('100')

    const onMocked = ipcMain.on as Mock
    expect(onMocked).toBeCalledTimes(2)
    expect(onMocked).toBeCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toBeCalledWith('eventa-error', expect.any(Function))

    const sendMocked = browserWindow.webContents.send as Mock
    expect(sendMocked).toBeCalledTimes(2)
    expect(sendMocked.mock.calls[0][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body.content).toEqual({ input: 100 })
    expect(sendMocked.mock.calls[1][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[1][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[1][1].payload.body.content).toEqual({ output: '100' })
  })

  it('should be able to invoke without window', async () => {
    const ipcMain = {
      on: vi.fn(),
    } as unknown as IpcMain
    const browserWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: {
        id: 1,
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
      },
    } as unknown as BrowserWindow

    const { context: ctx } = createContext(ipcMain)

    const events = defineInvokeEventa<Promise<{ output: string }>, { input: number }>()
    const input = defineInvoke(ctx, events)

    defineInvokeHandler(ctx, events, async (payload) => {
      return { output: String(payload.input) }
    })

    const res = await input({ input: 100 }, { raw: { ipcMainEvent: { sender: browserWindow.webContents } as IpcMainEvent, event: { content: { input: 100 } } } })
    expect(res.output).toEqual('100')

    const onMocked = ipcMain.on as Mock
    expect(onMocked).toBeCalledTimes(2)
    expect(onMocked).toBeCalledWith('eventa-message', expect.any(Function))
    expect(onMocked).toBeCalledWith('eventa-error', expect.any(Function))

    const sendMocked = browserWindow.webContents.send as Mock
    expect(sendMocked).toBeCalledTimes(2)
    expect(sendMocked.mock.calls[0][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[0][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[0][1].payload.body.content).toEqual({ input: 100 })
    expect(sendMocked.mock.calls[1][0]).toBeTypeOf('string')
    expect(sendMocked.mock.calls[1][1]).toBeTypeOf('object')
    expect(sendMocked.mock.calls[1][1].payload.body.content).toEqual({ output: '100' })
  })
})
