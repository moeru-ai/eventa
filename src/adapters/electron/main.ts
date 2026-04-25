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
  /**
   * When true, only respond to the renderer window that originally sent the request.
   * Applies to the `eventa-message` (invoke/response) channel only.
   */
  onlySameWindow?: boolean
  /**
   * IPC channel name for bidirectional invoke/response communication.
   * Renderer sends requests here; main replies here.
   * Set to `false` to disable.
   * @default 'eventa-message'
   */
  messageEventName?: string | false
  /**
   * IPC channel name for main-process proactive push events.
   * When a `window` is provided, pushes only to that specific window.
   * When no `window` is provided, broadcasts to all windows returned by `getWindows`.
   * Set to `false` to disable.
   * @default 'eventa-push'
   */
  pushEventName?: string | false
  /**
   * Returns the list of all BrowserWindow instances to broadcast push events to.
   * Only used when no `window` is bound to this context (i.e., broadcast mode).
   */
  getWindows?: () => BrowserWindow[]
  errorEventName?: string | false
  extraListeners?: Record<string, (_, event: Event) => void | Promise<void>>
  throwIfFailedToSend?: boolean
}) {
  const ctx = createBaseContext() as EventContext<
    { invokeRequest?: { raw?: { ipcMainEvent: IpcMainEvent, event: Event | unknown } } },
    { raw: { ipcMainEvent: IpcMainEvent, event: Event | unknown } }
  >

  const {
    messageEventName = 'eventa-message',
    pushEventName = 'eventa-push',
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

    // NOTICE: Two-channel routing splits on whether the emit originated from a renderer request.
    //
    // - eventa-message: invoke/response channel (renderer ↔ main).
    //   `onlySameWindow` filtering applies here to prevent cross-window response leakage.
    //
    // - eventa-push: main-process proactive push channel (main → renderer).
    //   Delivers to either a specific bound window or all windows (broadcast).
    //   `onlySameWindow` does NOT apply here — there is no originating renderer request.
    const isResponseToRenderer = !!callOptions?.raw?.ipcMainEvent

    try {
      if (isResponseToRenderer) {
        // Invoke/response path: reply on eventa-message, respect onlySameWindow
        if (!messageEventName) {
          return
        }

        if (window != null) {
          if (window.isDestroyed()) {
            return
          }
          if (onlySameWindow && window.webContents.id !== callOptions!.raw.ipcMainEvent.sender.id) {
            return
          }
          window.webContents.send(messageEventName, eventBody)
        }
        else {
          if (callOptions!.raw.ipcMainEvent.sender.isDestroyed()) {
            return
          }
          callOptions!.raw.ipcMainEvent.sender.send(messageEventName, eventBody)
        }
      }
      else {
        // Proactive push path: emit on eventa-push
        if (!pushEventName) {
          return
        }

        if (window != null) {
          // Specific window push — deliver only to the bound window
          if (window.isDestroyed()) {
            return
          }
          window.webContents.send(pushEventName, eventBody)
        }
        else {
          // Broadcast push — deliver to all windows provided by getWindows
          const targets = options?.getWindows?.() ?? []
          for (const win of targets) {
            if (!win.isDestroyed()) {
              win.webContents.send(pushEventName, eventBody)
            }
          }
        }
      }
    }
    catch (error) {
      // NOTICE: Electron may throw if the window is closed before sending
      // ignore the error if it's about destroyed object
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
    dispose: () => {
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
