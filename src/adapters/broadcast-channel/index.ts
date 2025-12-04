import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

function withRemoval<K extends keyof BroadcastChannelEventMap>(channel: BroadcastChannel, type: K, listener: (event: BroadcastChannelEventMap[K]) => void) {
  channel.addEventListener(type, listener)

  return {
    remove: () => {
      channel.removeEventListener(type, listener)
    },
  }
}

export interface BroadcastChannelAdapterOptions {
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

export function createContext(channel: BroadcastChannel, options?: BroadcastChannelAdapterOptions) {
  const ctx = createBaseContext() as EventContext<any, { raw: { message?: MessageEvent, messageError?: MessageEvent, error?: unknown } }>

  const {
    messageEvents: message = true,
    messageErrorEvents: messageError = true,
    closeOnDispose = false,
  } = options || {}

  const cleanupRemoval: Array<{ remove: () => void }> = []

  ctx.on(and(matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection), matchBy('*')), (event) => {
    const message = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })
    channel.postMessage(message)
  })

  if (message) {
    cleanupRemoval.push(withRemoval(channel, 'message', (event) => {
      try {
        const { type, payload } = parsePayload<Eventa<any>>(event.data)
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { message: event } })
      }
      catch (error) {
        console.error('Failed to parse BroadcastChannel message:', error)
        ctx.emit(errorEvent, { error }, { raw: { error } })
      }
    }))
  }

  if (messageError) {
    cleanupRemoval.push(withRemoval(channel, 'messageerror', (event) => {
      ctx.emit(errorEvent, { error: event }, { raw: { messageError: event } })
    }))
  }

  return {
    context: ctx,
    dispose: () => {
      cleanupRemoval.forEach(removal => removal.remove())
      if (closeOnDispose) {
        channel.close?.()
      }
    },
  }
}

export type * from './shared'
