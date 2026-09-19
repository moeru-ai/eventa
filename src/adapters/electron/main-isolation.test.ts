import type { IpcRenderer } from '@electron-toolkit/preload'
import type { BrowserWindow, IpcMain } from 'electron'

import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

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
  // https://github.com/moeru-ai/airi/issues/2579
  it('executes one handler for Issue #2579: a renderer request only in its bound window context', async () => {
    // ROOT CAUSE:
    // Both adapters listen on the same ipcMain channel. Filtering only replies
    // lets both handlers run, so one click produces two external side effects.
    const ipcMain = new EventEmitter()
    const first = createWindow(ipcMain, 1)
    const second = createWindow(ipcMain, 2)
    const mainA = createContext(ipcMain as IpcMain, first.window, { onlySameWindow: true })
    const mainB = createContext(ipcMain as IpcMain, second.window, { onlySameWindow: true })
    const renderer = createRendererContext(second.renderer)
    const open = defineInvokeEventa<{ path: string }>()
    const handlerA = vi.fn(() => ({ path: '/first' }))
    const handlerB = vi.fn(() => ({ path: '/second' }))
    defineInvokeHandler(mainA.context, open, handlerA)
    defineInvokeHandler(mainB.context, open, handlerB)
    try {
      await expect(defineInvoke(renderer.context, open)()).resolves.toEqual({ path: '/second' })
      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalledTimes(1)
      expect(first.window.webContents.send).not.toHaveBeenCalled()
    }
    finally {
      renderer.dispose()
      mainA.dispose()
      mainB.dispose()
    }
  })

  it('filters foreign messages before parsing, errors, and extra listeners', async () => {
    const ipcMain = new EventEmitter()
    const owner = createWindow(ipcMain, 1)
    const foreign = createWindow(ipcMain, 2)
    const extra = vi.fn()
    const errors = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = createContext(ipcMain as IpcMain, owner.window, {
      onlySameWindow: true,
      extraListeners: { extra },
    })
    adapter.context.on(errorEvent, errors)
    try {
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
    }
    finally {
      adapter.dispose()
      log.mockRestore()
    }
  })

  it('rejects pending calls and removes listeners when the bound window closes', async () => {
    const ipcMain = new EventEmitter()
    const owner = createWindow(ipcMain, 1)
    const adapter = createContext(ipcMain as IpcMain, owner.window, { onlySameWindow: true, extraListeners: { extra: vi.fn() } })
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
    const ipcMain = new EventEmitter()
    const first = createWindow(ipcMain, 1)
    const second = createWindow(ipcMain, 2)
    const mainA = createContext(ipcMain as IpcMain, first.window, { onlySameWindow: true })
    const mainB = createContext(ipcMain as IpcMain, second.window, { onlySameWindow: true })
    mainA.dispose()
    mainA.dispose()
    expect(first.window.listenerCount('closed')).toBe(0)
    expect(ipcMain.listenerCount('eventa-message')).toBe(1)
    expect(ipcMain.listenerCount('eventa-error')).toBe(1)
    first.close()
    expect(ipcMain.listenerCount('eventa-message')).toBe(1)
    mainB.dispose()
  })

  it('delivers response streams only through the requesting window', async () => {
    const ipcMain = new EventEmitter()
    const first = createWindow(ipcMain, 1)
    const second = createWindow(ipcMain, 2)
    const mainA = createContext(ipcMain as IpcMain, first.window, { onlySameWindow: true })
    const mainB = createContext(ipcMain as IpcMain, second.window, { onlySameWindow: true })
    const renderer = createRendererContext(second.renderer)
    const event = defineInvokeEventa<number>()
    const foreignHandler = vi.fn(async function* () {
      yield 99
    })
    defineStreamInvokeHandler(mainA.context, event, foreignHandler)
    defineStreamInvokeHandler(mainB.context, event, async function* () {
      yield 1
      yield 2
    })
    try {
      const received: number[] = []
      for await (const value of defineStreamInvoke(renderer.context, event)(undefined)) {
        received.push(value)
      }
      expect(received).toEqual([1, 2])
      expect(foreignHandler).not.toHaveBeenCalled()
      expect(first.window.webContents.send).not.toHaveBeenCalled()
    }
    finally {
      renderer.dispose()
      mainA.dispose()
      mainB.dispose()
    }
  })

  it('keeps receiving other windows when isolation is disabled', async () => {
    const ipcMain = new EventEmitter()
    const owner = createWindow(ipcMain, 1)
    const foreign = createWindow(ipcMain, 2)
    const adapter = createContext(ipcMain as IpcMain, owner.window)
    const renderer = createRendererContext(foreign.renderer)
    const event = defineEventa<string>()
    const received = vi.fn()
    adapter.context.on(event, received)
    try {
      await renderer.context.emit(event, 'hello')
      expect(received).toHaveBeenCalledTimes(1)
      expect(owner.window.listenerCount('closed')).toBe(0)
    }
    finally {
      renderer.dispose()
      adapter.dispose()
    }
  })

  it('requires a live window when isolation is enabled', () => {
    const ipcMain = new EventEmitter()
    expect(() => createContext(ipcMain as IpcMain, undefined, { onlySameWindow: true })).toThrow('live BrowserWindow')
    const owner = createWindow(ipcMain, 1)
    owner.close()
    expect(() => createContext(ipcMain as IpcMain, owner.window, { onlySameWindow: true })).toThrow('live BrowserWindow')
    expect(ipcMain.eventNames()).toEqual([])
  })

  it('keeps unbound contexts able to receive requests from any window', async () => {
    const ipcMain = new EventEmitter()
    const owner = createWindow(ipcMain, 1)
    const adapter = createContext(ipcMain as IpcMain)
    const renderer = createRendererContext(owner.renderer)
    const event = defineEventa<string>()
    const received = vi.fn()
    adapter.context.on(event, received)
    try {
      await renderer.context.emit(event, 'hello')
      expect(received).toHaveBeenCalledTimes(1)
    }
    finally {
      renderer.dispose()
      adapter.dispose()
    }
  })
})
