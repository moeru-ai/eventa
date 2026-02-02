import type { Hooks, Message, Peer } from 'crossws'

import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWebsocketPayload, parseWebsocketPayload } from '../internal'

export const wsConnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-peer:connected')
export const wsDisconnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-peer:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:websocket-peer:error')

export function createPeerContext(peer: Peer): {
  hooks: Pick<Hooks, 'message'>
  context: EventContext<any, { raw: { message: Message } }>
} {
  const peerId = peer.id
  const ctx = createBaseContext<any, { raw: { message: Message } }>()

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const data = JSON.stringify(generateWebsocketPayload(event.id, { ...defineOutboundEventa(event.type), ...event }))
    peer.send(data)
  })

  return {
    hooks: {
      message(peer, message) {
        if (peer.id === peerId) {
          try {
            const { type, payload } = parseWebsocketPayload<Eventa<any>>(message.text())
            ctx.emit(defineInboundEventa(type), payload.body, { raw: { message } })
          }
          catch (error) {
            console.error('Failed to parse WebSocket message:', error)
            ctx.emit(wsErrorEvent, { error }, { raw: { message } })
          }
        }
      },
    },
    context: ctx,
  }
}

export interface PeerContext { peer: Peer, context: EventContext<any, { raw: { message: Message } }> }

export function createPeerHooks(): { hooks: Partial<Hooks>, untilLeastOneConnected: Promise<PeerContext> } {
  let resolve: (value: PeerContext) => void
  const untilLeastOneConnected = new Promise<PeerContext>((r) => {
    resolve = r
  })

  let message: Hooks['message'] | undefined

  const hooks: Pick<Hooks, 'open' | 'message'> = {
    open: (peer) => {
      const { context, hooks } = createPeerContext(peer)
      message = hooks.message
      resolve({ peer, context })
    },
    message: (peer, msg) => {
      if (message != null) {
        message(peer, msg)
      }
    },
  }

  return { hooks, untilLeastOneConnected }
}
