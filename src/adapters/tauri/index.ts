import type { EventTarget, Event as TauriEvent } from '@tauri-apps/api/event'

import type { CreateContextOptions } from '../../context'
import type { EventaInner } from '../../internal'

import { emitTo as emitToTarget, listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { isInvokeEventa } from '../../invoke-shared'
import { toError } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

export type TauriTarget = string | EventTarget

export interface TauriAdapterOptions {
  /** Fixed target for every outbound Eventa message. */
  target: TauriTarget
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** Target whose messages this context receives. Defaults to the current webview's label. */
  listenTarget?: TauriTarget
  /** Use the same name on both peers and a distinct name for each peer pair. @default "eventa-message" */
  messageEventName?: string
}

export interface TauriEmitOptions {
  raw: { event: TauriEvent<unknown> }
}

export async function createContext(options: TauriAdapterOptions) {
  const ctx = createBaseContext<undefined, TauriEmitOptions>(options.context)
  const messageEventName = options.messageEventName ?? 'eventa-message'
  let disposePromise: Promise<void> | undefined

  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    const sendOperation = emitToTarget(options.target, messageEventName, inner)
    if (!isInvokeEventa(inner.eventa)) {
      return sendOperation
    }

    return sendOperation.catch((cause) => {
      const error = toError(cause, 'eventa: Tauri invoke send failed')
      stopSending()
      ctx.abort(error)
      void ctx.emit(defineInboundEventa(errorEvent.id), { kind: 'fatal', error }).catch(emitError => console.error('Failed to emit Tauri send error:', emitError))
    })
  })

  const listenTarget = options.listenTarget ?? getCurrentWebview().label
  const unlisten = await listen<EventaInner>(messageEventName, (event) => {
    try {
      const inner = restoreInner(event.payload)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { event } }).catch(emitError => console.error('Failed to emit Tauri message:', emitError))
    }
    catch (error) {
      console.error('Failed to parse Tauri message:', error)
      void ctx.emit(defineInboundEventa(errorEvent.id), { kind: 'parse', error: toError(error, 'eventa: Tauri message parse error') }, { raw: { event } }).catch(emitError => console.error('Failed to emit Tauri parse error:', emitError))
    }
  }, { target: listenTarget })

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      if (disposePromise) {
        return disposePromise
      }
      stopSending()
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, Tauri adapter disposed'))
      disposePromise = Promise.resolve().then(() => unlisten())
      return disposePromise
    },
  }
}

export { errorEvent } from './shared'
export type * from './shared'
