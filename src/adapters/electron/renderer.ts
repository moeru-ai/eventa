import type { IpcRenderer, IpcRendererListener } from '@electron-toolkit/preload'

import type { CreateContextOptions } from '../../context'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

/** Creates an Eventa Context backed by Electron renderer IPC. */
export interface ElectronRendererAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** IPC channel carrying Eventa inner values, or `false` to disable it. @default 'eventa-message' */
  messageEventName?: string | false
  /** IPC channel dispatched as adapter errors, or `false` to disable it. @default 'eventa-error' */
  errorEventName?: string | false
  /** Additional IPC listeners removed when the adapter is disposed. @default {} */
  extraListeners?: Record<string, IpcRendererListener>
}

/** Raw renderer IPC metadata exposed to Eventa listeners. */
export interface ElectronRendererEmitOptions {
  raw: { ipcRendererEvent: Electron.IpcRendererEvent, event: Event | unknown }
}

export function createContext(ipcRenderer: IpcRenderer, options?: ElectronRendererAdapterOptions) {
  const ctx = createBaseContext<undefined, ElectronRendererEmitOptions>(options?.context)
  const {
    messageEventName = 'eventa-message',
    errorEventName = 'eventa-error',
    extraListeners = {},
  } = options || {}
  const cleanupRemoval: Array<{ remove: () => void }> = []
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    // The message channel is disabled; do not publish to Electron IPC.
    if (messageEventName === false) {
      return
    }
    try {
      ipcRenderer.send(messageEventName, inner)
    }
    catch (error) {
      // Electron may close the target between scheduling and send.
      if (!(error instanceof Error) || error.message !== 'Object has been destroyed') {
        throw error
      }
    }
  })

  function handleIncomingMessage(ipcRendererEvent: Electron.IpcRendererEvent, event: Event | unknown) {
    try {
      const inner = restoreInner(event)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { ipcRendererEvent, event } }).catch(emitError => console.error('Failed to emit IpcRenderer message:', emitError))
    }
    catch (error) {
      console.error('Failed to parse IpcRenderer message:', error)
      void ctx.emit(errorEvent, { error }, { raw: { ipcRendererEvent, event } }).catch(emitError => console.error('Failed to emit IpcRenderer parse error:', emitError))
    }
  }

  if (messageEventName) {
    ipcRenderer.on(messageEventName, handleIncomingMessage)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(messageEventName, handleIncomingMessage) })
  }
  if (errorEventName) {
    const handleErrorMessage: IpcRendererListener = (ipcRendererEvent, error) => {
      void ctx.emit(errorEvent, { error }, { raw: { ipcRendererEvent, event: error } }).catch(emitError => console.error('Failed to emit IpcRenderer error:', emitError))
    }
    ipcRenderer.on(errorEventName, handleErrorMessage)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(errorEventName, handleErrorMessage) })
  }
  for (const [eventName, listener] of Object.entries(extraListeners)) {
    ipcRenderer.on(eventName, listener)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(eventName, listener) })
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      stopSending()
      // Reject main-bound invokes before removing their response listeners.
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, electron renderer ipc disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
