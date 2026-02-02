import type { Hooks, Message, Peer, WSError } from 'crossws'

import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWebsocketPayload, parseWebsocketPayload } from '../internal'

export const wsConnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-global:connected')
export const wsDisconnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-global:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:websocket-global:error')

export function createGlobalContext(): {
  websocketHandlers: Omit<Hooks, 'upgrade'>
  context: EventContext<any, { raw: { error?: WSError, message?: Message } }>
} {
  const ctx = createBaseContext<any, { raw: { error?: WSError, message?: Message } }>()
  const peers = new Set<Peer>()

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const data = JSON.stringify(generateWebsocketPayload(event.id, { ...defineOutboundEventa(event.type), ...event }))
    for (const peer of peers) {
      peer.send(data)
    }
  })

  return {
    websocketHandlers: {
      open(peer) {
        peers.add(peer)
        ctx.emit(wsConnectedEvent, { id: peer.id }, { raw: { } })
      },

      close(peer) {
        peers.delete(peer)
        ctx.emit(wsDisconnectedEvent, { id: peer.id }, { raw: { } })
      },

      error(_, error) {
        console.error('WebSocket error:', error)
        ctx.emit(wsErrorEvent, { error }, { raw: { error } })
      },

      async message(_, message) {
        try {
          const { type, payload } = parseWebsocketPayload<Eventa<any>>(message.text())
          ctx.emit(defineInboundEventa(type), payload.body, { raw: { message } })
        }
        catch (error) {
          console.error('Failed to parse WebSocket message:', error)
          ctx.emit(wsErrorEvent, { error }, { raw: { message } })
        }
      },
    },
    context: ctx,
  }
}
