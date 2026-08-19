import type { CreateContextOptions } from '../../context'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOnceReporter } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

function withRemoval<K extends keyof BroadcastChannelEventMap>(channel: BroadcastChannel, type: K, listener: (event: BroadcastChannelEventMap[K]) => void) {
  channel.addEventListener(type, listener)

  return {
    remove: () => {
      channel.removeEventListener(type, listener)
    },
  }
}

/** Creates an Eventa Context backed by a BroadcastChannel. */
export interface BroadcastChannelAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /**
   * Whether to listen to `message` events.
   * @default true
   */
  messageEvents?: boolean
  /**
   * Whether to listen to `messageerror` events.
   * @default true
   */
  messageErrorEvents?: boolean
  /**
   * Whether to close the BroadcastChannel when disposing the context.
   * @default false
   */
  closeOnDispose?: boolean
}

/** Raw BroadcastChannel metadata exposed to Eventa listeners. */
export interface BroadcastChannelEmitOptions {
  raw: { message?: MessageEvent, messageError?: MessageEvent, error?: unknown }
}

export function createContext(channel: BroadcastChannel, options?: BroadcastChannelAdapterOptions) {
  const ctx = createBaseContext<undefined, BroadcastChannelEmitOptions>(options?.context)
  const {
    messageEvents: message = true,
    messageErrorEvents: messageError = true,
    closeOnDispose = false,
  } = options || {}
  const cleanupRemoval: Array<{ remove: () => void }> = []
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse BroadcastChannel message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (inner) {
      channel.postMessage(inner)
    }
  })

  if (message) {
    cleanupRemoval.push(withRemoval(channel, 'message', (event) => {
      try {
        const inner = restoreInner(event.data)
        void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }).catch(emitError => console.error('Failed to emit BroadcastChannel message:', emitError))
      }
      catch (error) {
        reportParseError(error)
        void ctx.emit(errorEvent, { error }, { raw: { error } }).catch(emitError => console.error('Failed to emit BroadcastChannel parse error:', emitError))
      }
    }))
  }

  if (messageError) {
    cleanupRemoval.push(withRemoval(channel, 'messageerror', (event) => {
      void ctx.emit(errorEvent, { error: event }, { raw: { messageError: event } }).catch(emitError => console.error('Failed to emit BroadcastChannel message error:', emitError))
    }))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      stopSending()
      // Reject pending invokes before removing listeners or closing the channel.
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, BroadcastChannel disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
      if (closeOnDispose) {
        channel.close?.()
      }
    },
  }
}

export type * from './shared'
