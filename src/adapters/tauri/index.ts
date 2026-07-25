import type { EventTarget, Event as TauriEvent, UnlistenFn } from '@tauri-apps/api/event'

import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'
import type { Payload } from './shared'

import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { isInvokeEventa } from '../../invoke-shared'
import { toError } from '../errors'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

export type TauriTarget = string | EventTarget

export interface TauriAdapterOptions {
  /** Fixed target for every outbound Eventa message. */
  target: TauriTarget
  /**
   * Target whose messages this context receives. Defaults to the current
   * webview's label.
   */
  listenTarget?: TauriTarget
  /** Use the same name on both peers and a distinct name for each peer pair. @default "eventa-message" */
  messageEventName?: string | false
}

export interface TauriEmitOptions {
  raw: {
    event: TauriEvent<unknown>
  }
}

export async function createContext(options: TauriAdapterOptions) {
  const ctx = createBaseContext() as EventContext<any, TauriEmitOptions>
  const messageEventName = options.messageEventName ?? 'eventa-message'

  let disposed = false
  let unlisten: UnlistenFn | undefined
  let disposePromise: Promise<void> | undefined
  let sendQueue = Promise.resolve()

  const removeOutbound = ctx.on(and(
    matchBy((event: DirectionalEventa<any>) => event._flowDirection === EventaFlowDirection.Outbound || !event._flowDirection),
    matchBy('*'),
  ), (event) => {
    if (messageEventName === false) {
      return
    }

    const data = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })

    const sendOperation = sendQueue.then(async () => {
      if (disposed) {
        // dispose() already aborts the context and removes this listener. A
        // send queued just before disposal is simply dropped; rejecting here
        // would become unhandled in Eventa invoke paths that intentionally
        // fire-and-forget their internal ctx.emit() calls.
        return
      }
      await emitTo(options.target, messageEventName, data)
    })

    // Keep later sends usable if this operation fails. Ordinary Eventa events
    // receive sendOperation directly; invoke events use context cancellation
    // below because Eventa intentionally fire-and-forgets its async emits.
    sendQueue = sendOperation.catch(() => void 0)

    if (!isInvokeEventa(event)) {
      return sendOperation
    }

    return sendOperation.catch((error) => {
      const normalized = toError(error, 'eventa: Tauri invoke send failed')
      ctx.abort(normalized)
      void ctx.emit(
        defineInboundEventa(errorEvent.id),
        { kind: 'fatal', error: normalized },
      ).catch(dispatchError => console.error('Failed to dispatch Tauri adapter error:', dispatchError))
    })
  })

  function emitParseError(error: unknown, event: TauriEvent<unknown>) {
    void ctx.emit(
      defineInboundEventa(errorEvent.id),
      { kind: 'parse', error: toError(error, 'eventa: Tauri message parse error') },
      { raw: { event } },
    ).catch(dispatchError => console.error('Failed to dispatch Tauri adapter error:', dispatchError))
  }

  try {
    if (messageEventName !== false) {
      const listenTarget = options.listenTarget ?? getCurrentWebview().label

      unlisten = await listen<Payload<Eventa<any>>>(messageEventName, (event) => {
        try {
          const { type, payload } = parsePayload<Eventa<any>>(event.payload)
          const inboundEvent = {
            ...payload,
            ...defineInboundEventa(type),
          }

          void ctx.emit(inboundEvent, payload.body, { raw: { event } })
            .catch(error => console.error('Failed to dispatch Tauri message:', error))
        }
        catch (error) {
          console.error('Failed to parse Tauri message:', error)
          emitParseError(error, event)
        }
      }, { target: listenTarget })
    }
  }
  catch (error) {
    disposed = true
    removeOutbound()
    ctx.abort(error)
    throw error
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      if (disposePromise) {
        return disposePromise
      }

      disposed = true
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, Tauri adapter disposed'))
      removeOutbound()

      disposePromise = Promise.resolve()
        .then(() => unlisten?.())
        .then(() => void 0)

      return disposePromise
    },
  }
}

export { errorEvent } from './shared'
export type * from './shared'
