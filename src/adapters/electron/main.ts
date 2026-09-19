import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'

import type { CreateContextOptions } from '../../context'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

function withRemoval(ipcMain: IpcMain, type: string, listener: Parameters<IpcMain['on']>[1]) {
  ipcMain.on(type, listener)
  return { remove: () => ipcMain.off(type, listener) }
}

/** Creates an Eventa Context backed by Electron main-process IPC. */
export interface ElectronMainAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /**
   * Accepts IPC messages only from the bound window and sends only to that window.
   * Includes error messages and extra listeners. Requires a live BrowserWindow.
   * Closing the window disposes the adapter and rejects pending calls.
   * @default false
   */
  onlySameWindow?: boolean
  /** IPC channel carrying Eventa inner values, or `false` to disable it. @default 'eventa-message' */
  messageEventName?: string | false
  /** IPC channel dispatched as adapter errors, or `false` to disable it. @default 'eventa-error' */
  errorEventName?: string | false
  /** Additional IPC listeners removed when the adapter is disposed. @default {} */
  extraListeners?: Record<string, (ipcMainEvent: IpcMainEvent, event: Event) => void | Promise<void>>
  /** Reserved send-failure policy option. @default false */
  throwIfFailedToSend?: boolean
}

/** Raw main-process IPC metadata exposed to Eventa listeners. */
export interface ElectronMainEmitOptions {
  raw: { ipcMainEvent: IpcMainEvent, event: Event | unknown }
}

/** Invoke metadata made available by the Electron main-process context. */
export interface ElectronMainContextExtensions {
  invokeRequest?: { raw?: ElectronMainEmitOptions['raw'] }
}

/**
 * Binds a context to Electron IPC. A supplied window selects the send target.
 * Enable `onlySameWindow` to restrict incoming IPC and tie disposal to window closure.
 * Otherwise, the caller must dispose the adapter when its owner stops.
 */
export function createContext(ipcMain: IpcMain, window?: BrowserWindow, options?: ElectronMainAdapterOptions) {
  const {
    messageEventName = 'eventa-message',
    errorEventName = 'eventa-error',
    extraListeners = {},
    onlySameWindow = false,
  } = options || {}
  if (onlySameWindow && (!window || window.isDestroyed() || window.webContents.isDestroyed())) {
    throw new TypeError('eventa: onlySameWindow requires a live BrowserWindow')
  }

  const boundWindow = onlySameWindow ? window : undefined
  const ctx = createBaseContext<ElectronMainContextExtensions, ElectronMainEmitOptions>(options?.context)
  const cleanupRemoval: Array<{ remove: () => void }> = []
  let disposed = false

  // All IPC channels use the same window boundary, before parsing or dispatch.
  // This also isolates invoke replies, stream frames, and cancellation messages.
  function listen(type: string, listener: Parameters<IpcMain['on']>[1]) {
    cleanupRemoval.push(withRemoval(ipcMain, type, (event, ...args) => {
      if (disposed || (boundWindow && event.sender !== boundWindow.webContents)) {
        return
      }
      return listener(event, ...args)
    }))
  }
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event, callOptions) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    // The message channel is disabled; do not publish to Electron IPC.
    if (messageEventName === false) {
      return
    }

    try {
      // Prefer the bound BrowserWindow over inherited raw.sender metadata.
      if (window != null) {
        if (window.isDestroyed()) {
          return
        }
        // onlySameWindow applies only when this emit inherits an inbound IPC sender.
        if (onlySameWindow && callOptions?.raw?.ipcMainEvent != null && window.webContents.id !== callOptions.raw.ipcMainEvent.sender.id) {
          return
        }
        // Keep one Eventa IPC channel; raw metadata never selects the wire protocol.
        window.webContents.send(messageEventName, inner)
        return
      }

      // Without a bound window, the inbound IPC sender is the only known destination.
      const sender = callOptions?.raw?.ipcMainEvent?.sender
      if (sender != null && !sender.isDestroyed()) {
        sender.send(messageEventName, inner)
      }
    }
    catch (error) {
      // Electron may close the target between the lifecycle check and send.
      if (!(error instanceof Error) || error.message !== 'Object has been destroyed') {
        throw error
      }
    }
  })

  if (messageEventName) {
    listen(messageEventName, (ipcMainEvent, event: Event | unknown) => {
      try {
        const inner = restoreInner(event)
        void ctx.emit(inner.eventa, inner.eventa.body, { raw: { ipcMainEvent, event } }).catch(emitError => console.error('Failed to emit IpcMain message:', emitError))
      }
      catch (error) {
        console.error('Failed to parse IpcMain message:', error)
        void ctx.emit(errorEvent, { error }, { raw: { ipcMainEvent, event } }).catch(emitError => console.error('Failed to emit IpcMain parse error:', emitError))
      }
    })
  }

  if (errorEventName) {
    listen(errorEventName, (ipcMainEvent, error: Event | unknown) => {
      void ctx.emit(errorEvent, { error }, { raw: { ipcMainEvent, event: error } }).catch(emitError => console.error('Failed to emit IpcMain error:', emitError))
    })
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    listen(eventName, listener)
  }

  function dispose(reason?: unknown) {
    if (disposed) {
      return
    }
    disposed = true
    stopSending()
    // Reject pending calls before removing the IPC listeners that carry replies.
    ctx.abort(reason ?? new Error('eventa: invoke cancelled, electron main ipc disposed'))
    cleanupRemoval.forEach(removal => removal.remove())
    if (boundWindow) {
      boundWindow.off('closed', onWindowClosed)
    }
  }

  function onWindowClosed() {
    dispose(new Error('eventa: invoke cancelled, electron window closed'))
  }

  if (boundWindow) {
    boundWindow.once('closed', onWindowClosed)
  }

  return { context: ctx, dispose }
}

export type * from './shared'
