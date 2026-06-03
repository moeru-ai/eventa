import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'

import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

function withRemoval(ipcMain: IpcMain, type: string, listener: Parameters<IpcMain['on']>[1]) {
  ipcMain.on(type, listener)

  return {
    remove: () => {
      ipcMain.off(type, listener)
    },
  }
}

export function createContext(ipcMain: IpcMain, window?: BrowserWindow, options?: {
  onlySameWindow?: boolean
  messageEventName?: string | false
  errorEventName?: string | false
  extraListeners?: Record<string, (ipcMainEvent: IpcMainEvent, event: Event) => void | Promise<void>>
  throwIfFailedToSend?: boolean
}) {
  const ctx = createBaseContext() as EventContext<
    { invokeRequest?: { raw?: { ipcMainEvent: IpcMainEvent, event: Event | unknown } } },
    { raw: { ipcMainEvent: IpcMainEvent, event: Event | unknown } }
  >

  const {
    messageEventName = 'eventa-message',
    errorEventName = 'eventa-error',
    extraListeners = {},
    onlySameWindow = false,
  } = options || {}

  const cleanupRemoval: Array<{ remove: () => void }> = []

  ctx.on(and(
    matchBy('*'),
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
  ), (event, callOptions) => {
    const eventBody = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })

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

        // Keep one Eventa IPC channel; inherited raw metadata must not choose the wire protocol.
        window.webContents.send(messageEventName, eventBody)
      }
      else {
        // Without a bound window, the inbound IPC sender is the only known destination.
        const sender = callOptions?.raw?.ipcMainEvent?.sender

        if (sender == null || sender.isDestroyed()) {
          return
        }

        sender.send(messageEventName, eventBody)
      }
    }
    catch (error) {
      // Electron may close the target between the lifecycle check and send.
      if (!(error instanceof Error) || error?.message !== 'Object has been destroyed') {
        throw error
      }
    }
  })

  if (messageEventName) {
    cleanupRemoval.push(withRemoval(ipcMain, messageEventName, (ipcMainEvent, event: Event | unknown) => {
      try {
        const { type, payload } = parsePayload<Eventa<any>>(event)
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { ipcMainEvent, event } })
      }
      catch (error) {
        console.error('Failed to parse IpcMain message:', error)
        ctx.emit(errorEvent, { error }, { raw: { ipcMainEvent, event } })
      }
    }))
  }

  if (errorEventName) {
    cleanupRemoval.push(withRemoval(ipcMain, errorEventName, (ipcMainEvent, error: Event | unknown) => {
      ctx.emit(errorEvent, { error }, { raw: { ipcMainEvent, event: error } })
    }))
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    cleanupRemoval.push(withRemoval(ipcMain, eventName, listener))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      // Cascade-cancel any in-flight `defineInvoke(...)` so renderer-bound
      // RPCs don't hang after the main-side adapter is torn down.
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, electron main ipc disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
