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
  hooks: Pick<Hooks, 'message' | 'close' | 'error'>
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
            // Per-message parse failure — recoverable, do NOT abort lifetime.
            console.error('Failed to parse WebSocket message:', error)
            ctx.emit(wsErrorEvent, { error }, { raw: { message } })
          }
        }
      },
      close(peer, details) {
        // crossws fires close for ANY peer; filter to our own.
        if (peer.id !== peerId) {
          return
        }
        const reasonText = details.reason ? ` (${details.reason})` : ''
        // Cascade-cancel any in-flight `defineInvoke(...)` so server-side code
        // that issued an invoke back to this peer doesn't hang on close.
        ctx.abort(new Error(`eventa: invoke cancelled, peer disconnected${reasonText}`))
        ctx.emit(wsDisconnectedEvent, { id: peerId })
      },
      error(peer, error) {
        if (peer.id !== peerId) {
          return
        }
        ctx.abort(error instanceof Error ? error : new Error('eventa: invoke cancelled, peer error'))
        ctx.emit(wsErrorEvent, { error })
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

  // NOTICE: single-peer model — these closure-scoped hook refs get overwritten
  // when a second peer connects, so `createPeerHooks` only correctly serves the
  // most-recently-opened peer. Multi-peer support requires a peerId-keyed Map
  // and a different "untilLeastOneConnected" semantic; out of scope here.
  let message: Hooks['message'] | undefined
  let close: Hooks['close'] | undefined
  let error: Hooks['error'] | undefined

  const hooks: Pick<Hooks, 'open' | 'message' | 'close' | 'error'> = {
    open: (peer) => {
      const { context, hooks } = createPeerContext(peer)
      message = hooks.message
      close = hooks.close
      error = hooks.error
      resolve({ peer, context })
    },
    message: (peer, msg) => {
      message?.(peer, msg)
    },
    close: (peer, details) => {
      close?.(peer, details)
    },
    error: (peer, err) => {
      error?.(peer, err)
    },
  }

  return { hooks, untilLeastOneConnected }
}
