import type { EventTarget, Event as TauriEvent } from '@tauri-apps/api/event'

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
  messageEventName?: string
}

export interface TauriEmitOptions {
  raw: {
    event: TauriEvent<unknown>
  }
}

export async function createContext(options: TauriAdapterOptions) {
  const ctx = createBaseContext() as EventContext<any, TauriEmitOptions>
  const messageEventName = options.messageEventName ?? 'eventa-message'

  let disposePromise: Promise<void> | undefined

  const removeOutbound = ctx.on(and(
    matchBy((event: DirectionalEventa<any>) => event._flowDirection === EventaFlowDirection.Outbound || !event._flowDirection),
    matchBy('*'),
  ), (event) => {
    const data = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })

    const sendOperation = emitTo(options.target, messageEventName, data)

    if (!isInvokeEventa(event)) {
      return sendOperation
    }

    return sendOperation.catch((cause) => {
      const error = toError(cause, 'eventa: Tauri invoke send failed')
      ctx.abort(error)
      void ctx.emit(
        defineInboundEventa(errorEvent.id),
        { kind: 'fatal', error },
      ).catch(dispatchError => console.error('Failed to dispatch Tauri adapter error:', dispatchError))
    })
  })

  const listenTarget = options.listenTarget ?? getCurrentWebview().label

  const unlisten = await listen<Payload<Eventa<any>>>(messageEventName, (event) => {
    try {
      const { type, payload } = parsePayload<Eventa<any>>(event.payload)
      void ctx.emit(defineInboundEventa(type), payload.body, { raw: { event } })
        .catch(error => console.error('Failed to dispatch Tauri message:', error))
    }
    catch (error) {
      console.error('Failed to parse Tauri message:', error)
      void ctx.emit(
        defineInboundEventa(errorEvent.id),
        { kind: 'parse', error: toError(error, 'eventa: Tauri message parse error') },
        { raw: { event } },
      ).catch(dispatchError => console.error('Failed to dispatch Tauri adapter error:', dispatchError))
    }
  }, { target: listenTarget })

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      if (disposePromise) {
        return disposePromise
      }

      ctx.abort(reason ?? new Error('eventa: invoke cancelled, Tauri adapter disposed'))
      removeOutbound()

      disposePromise = Promise.resolve().then(() => unlisten())

      return disposePromise
    },
  }
}

export { errorEvent } from './shared'
export type * from './shared'
