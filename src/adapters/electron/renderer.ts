import type { IpcRenderer, IpcRendererListener } from '@electron-toolkit/preload'

import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

export function createContext(ipcRenderer: IpcRenderer, options?: {
  /**
   * IPC channel name for bidirectional invoke/response communication.
   * Renderer sends requests here; main replies here.
   * Set to `false` to disable.
   * @default 'eventa-message'
   */
  messageEventName?: string | false
  /**
   * IPC channel name for main-process proactive push events.
   * The renderer listens on this channel to receive push events from main,
   * regardless of whether they target a specific window or are broadcast to all windows.
   * Set to `false` to disable.
   * @default 'eventa-push'
   */
  pushEventName?: string | false
  errorEventName?: string | false
  extraListeners?: Record<string, IpcRendererListener>
}) {
  const ctx = createBaseContext() as EventContext<any, { raw: { ipcRendererEvent: Electron.IpcRendererEvent, event: Event | unknown } }>

  const {
    messageEventName = 'eventa-message',
    pushEventName = 'eventa-push',
    errorEventName = 'eventa-error',
    extraListeners = {},
  } = options || {}

  const cleanupRemoval: Array<{ remove: () => void }> = []

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const eventBody = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })
    if (messageEventName !== false) {
      try {
        ipcRenderer.send(messageEventName, eventBody)
      }
      catch (error) {
        if (!(error instanceof Error) || error?.message !== 'Object has been destroyed') {
          throw error
        }
      }
    }
  })

  // NOTICE: Shared handler for all incoming events from the main process.
  // Both eventa-message (invoke/response) and eventa-push (proactive push) carry
  // identical payload formats and are handled identically on the renderer side.
  // The channel separation is only meaningful on the main-process side for routing.
  function handleIncomingMessage(ipcRendererEvent: Electron.IpcRendererEvent, event: Event | unknown) {
    try {
      const { type, payload } = parsePayload<Eventa<any>>(event)
      ctx.emit(defineInboundEventa(type), payload.body, { raw: { ipcRendererEvent, event } })
    }
    catch (error) {
      console.error('Failed to parse IpcRenderer message:', error)
      ctx.emit(errorEvent, { error }, { raw: { ipcRendererEvent, event } })
    }
  }

  if (messageEventName) {
    ipcRenderer.on(messageEventName, handleIncomingMessage)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(messageEventName, handleIncomingMessage) })
  }

  // Listen on the push channel for proactive main-process events.
  // This covers both specific-window and broadcast delivery modes — the renderer
  // does not need to distinguish between them.
  if (pushEventName) {
    ipcRenderer.on(pushEventName, handleIncomingMessage)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(pushEventName, handleIncomingMessage) })
  }

  if (errorEventName) {
    const handleErrorMessage: IpcRendererListener = (ipcRendererEvent, error) => {
      ctx.emit(errorEvent, { error }, { raw: { ipcRendererEvent, event: error } })
    }
    ipcRenderer.on(errorEventName, handleErrorMessage)
    cleanupRemoval.push({ remove: () => ipcRenderer.removeListener(errorEventName, handleErrorMessage) })
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    ipcRenderer.on(eventName, listener)
  }

  return {
    context: ctx,
    dispose: () => {
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
