import type { Hooks, Message, Peer } from 'crossws'

import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { createContext as createBaseContext } from '../../../context'
import { registerInvokeAbortEventListeners } from '../../../context-extension-invoke-internal'
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

  // Reject any in-flight `defineInvoke(...)` promises if this peer's transport
  // dies. Mirrors the native ws adapter so server-side code that issues an
  // invoke back to a client (push-style RPC) doesn't hang on close.
  registerInvokeAbortEventListeners(ctx, wsDisconnectedEvent, (payload) => {
    if (payload.id === wsDisconnectedEvent.id) {
      const id = (payload as Eventa<{ id?: string }>).body?.id
      return new Error(`eventa: invoke cancelled, peer disconnected${id ? ` (${id})` : ''}`)
    }
    if (payload.id === wsErrorEvent.id) {
      const err = (payload as Eventa<{ error?: unknown }>).body?.error
      return err instanceof Error ? err : new Error('eventa: invoke cancelled, peer error')
    }
    return undefined
  })
  registerInvokeAbortEventListeners(ctx, wsErrorEvent)

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
