import type { IpcRenderer } from '@electron-toolkit/preload'
import type { BrowserWindow, IpcMain } from 'electron'

import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { defineEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler } from '../../stream'
import { createContext } from './main'
import { createContext as createRendererContext } from './renderer'
import { errorEvent } from './shared'

function createWindow(ipcMain: EventEmitter, id: number) {
  const ipcRenderer = new EventEmitter()
  const lifecycle = new EventEmitter()
  let destroyed = false
  const webContents = {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn((channel: string, value: unknown) => ipcRenderer.emit(channel, {}, structuredClone(value))),
  }
  const window = Object.assign(lifecycle, { webContents, isDestroyed: () => destroyed })
  const renderer = Object.assign(ipcRenderer, {
    send: (channel: string, value: unknown) => ipcMain.emit(channel, { sender: webContents }, structuredClone(value)),
  })
  return {
    window: window as unknown as BrowserWindow,
    renderer: renderer as unknown as IpcRenderer,
    close: () => {
      destroyed = true
      lifecycle.emit('closed')
    },
  }
}

describe('electron window isolation', () => {
  let ipcMain: IpcMain
  let owner: ReturnType<typeof createWindow>
  let foreign: ReturnType<typeof createWindow>

  beforeEach(() => {
    ipcMain = new EventEmitter() as IpcMain
    owner = createWindow(ipcMain, 1)
    foreign = createWindow(ipcMain, 2)
  })

  afterEach(() => {
    owner.close()
    foreign.close()
    vi.restoreAllMocks()
  })

  // https://github.com/moeru-ai/airi/issues/2579
  it('executes only the requesting window handler (Issue #2579)', async () => {
    // ROOT CAUSE:
    // Both adapters listen on the same ipcMain channel. Filtering only replies
    // lets both handlers run, so one click produces two external side effects.
    const foreignMain = createContext(ipcMain, foreign.window, { onlySameWindow: true })
    const ownerMain = createContext(ipcMain, owner.window, { onlySameWindow: true })
    const renderer = createRendererContext(owner.renderer)
    const open = defineInvokeEventa<{ path: string }>()
    const foreignHandler = vi.fn(() => ({ path: '/foreign' }))
    const ownerHandler = vi.fn(() => ({ path: '/owner' }))
    defineInvokeHandler(foreignMain.context, open, foreignHandler)
    defineInvokeHandler(ownerMain.context, open, ownerHandler)
    onTestFinished(renderer.dispose)
    await expect(defineInvoke(renderer.context, open)()).resolves.toEqual({ path: '/owner' })
    expect(foreignHandler).not.toHaveBeenCalled()
    expect(ownerHandler).toHaveBeenCalledTimes(1)
    expect(foreign.window.webContents.send).not.toHaveBeenCalled()
  })

  it('filters foreign messages before parsing, errors, and extra listeners', async () => {
    const extra = vi.fn()
    const errors = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = createContext(ipcMain, owner.window, {
      onlySameWindow: true,
      extraListeners: { extra },
    })
    adapter.context.on(errorEvent, errors)
    foreign.renderer.send('eventa-message', null)
    foreign.renderer.send('eventa-error', 'foreign error')
    foreign.renderer.send('extra', 'foreign extra')
    await Promise.resolve()
    expect(errors).not.toHaveBeenCalled()
    expect(extra).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    owner.renderer.send('eventa-error', 'owner error')
    owner.renderer.send('extra', 'owner extra')
    await Promise.resolve()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(extra).toHaveBeenCalledTimes(1)
  })

  it('rejects pending calls and removes listeners when the bound window closes', async () => {
    const adapter = createContext(ipcMain, owner.window, { onlySameWindow: true, extraListeners: { extra: vi.fn() } })
    const pending = defineInvoke(adapter.context, defineInvokeEventa<string>())()
    const rejected = expect(pending).rejects.toThrow('window closed')
    owner.close()
    await rejected
    expect(ipcMain.listenerCount('eventa-message')).toBe(0)
    expect(ipcMain.listenerCount('eventa-error')).toBe(0)
    expect(ipcMain.listenerCount('extra')).toBe(0)
    expect(owner.window.listenerCount('closed')).toBe(0)
    adapter.dispose()
  })

  it('removes its close listener on manual disposal without affecting another adapter', () => {
    const foreignMain = createContext(ipcMain, foreign.window, { onlySameWindow: true })
    const ownerMain = createContext(ipcMain, owner.window, { onlySameWindow: true })
    foreignMain.dispose()
    foreignMain.dispose()
    expect(foreign.window.listenerCount('closed')).toBe(0)
    expect(ipcMain.listenerCount('eventa-message')).toBe(1)
    expect(ipcMain.listenerCount('eventa-error')).toBe(1)
    foreign.close()
    expect(ipcMain.listenerCount('eventa-message')).toBe(1)
    ownerMain.dispose()
  })

  it('delivers response streams only through the requesting window', async () => {
    const foreignMain = createContext(ipcMain, foreign.window, { onlySameWindow: true })
    const ownerMain = createContext(ipcMain, owner.window, { onlySameWindow: true })
    const renderer = createRendererContext(owner.renderer)
    const event = defineInvokeEventa<number>()
    const foreignHandler = vi.fn(async function* () {
      yield 99
    })
    defineStreamInvokeHandler(foreignMain.context, event, foreignHandler)
    defineStreamInvokeHandler(ownerMain.context, event, async function* () {
      yield 1
      yield 2
    })
    onTestFinished(renderer.dispose)
    const received: number[] = []
    for await (const value of defineStreamInvoke(renderer.context, event)(undefined)) {
      received.push(value)
    }
    expect(received).toEqual([1, 2])
    expect(foreignHandler).not.toHaveBeenCalled()
    expect(foreign.window.webContents.send).not.toHaveBeenCalled()
  })

  it('requires a live window when isolation is enabled', () => {
    expect(() => createContext(ipcMain, undefined, { onlySameWindow: true })).toThrow('live BrowserWindow')
    owner.close()
    expect(() => createContext(ipcMain, owner.window, { onlySameWindow: true })).toThrow('live BrowserWindow')
    expect(ipcMain.eventNames()).toEqual([])
  })

  it.each(['bound', 'unbound'] as const)('accepts any sender in a %s context by default', async (binding) => {
    const adapter = createContext(ipcMain, binding === 'bound' ? owner.window : undefined)
    const renderer = createRendererContext(foreign.renderer)
    onTestFinished(renderer.dispose)
    onTestFinished(adapter.dispose)
    const event = defineEventa<string>()
    const received = vi.fn()
    adapter.context.on(event, received)
    await renderer.context.emit(event, 'hello')
    expect(received).toHaveBeenCalledTimes(1)
    expect(owner.window.listenerCount('closed')).toBe(0)
  })
})
