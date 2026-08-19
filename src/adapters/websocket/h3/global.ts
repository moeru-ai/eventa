import type { Hooks, Message, Peer, WSError } from 'crossws'

import type { CreateContextOptions, EventContext } from '../../../context'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'

export const wsConnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-global:connected')
export const wsDisconnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-global:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:websocket-global:error')

/** Creates one Eventa Context shared by all connected H3 WebSocket peers. */
export interface H3GlobalAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

export function createGlobalContext(options?: H3GlobalAdapterOptions): {
  websocketHandlers: Omit<Hooks, 'upgrade'>
  context: EventContext<undefined, { raw: { error?: WSError, message?: Message } }>
} {
  interface EmitOptions { raw: { error?: WSError, message?: Message } }
  const ctx = createBaseContext<undefined, EmitOptions>(options?.context)
  const peers = new Set<Peer>()
  ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    const data = JSON.stringify(inner)
    for (const peer of peers) {
      peer.send(data)
    }
  })

  return {
    websocketHandlers: {
      open(peer) {
        peers.add(peer)
        void ctx.emit(wsConnectedEvent, { id: peer.id }, { raw: {} }).catch(emitError => console.error('Failed to emit WebSocket open event:', emitError))
      },
      close(peer) {
        peers.delete(peer)
        void ctx.emit(wsDisconnectedEvent, { id: peer.id }, { raw: {} }).catch(emitError => console.error('Failed to emit WebSocket close event:', emitError))
      },
      error(_, error) {
        console.error('WebSocket error:', error)
        void ctx.emit(wsErrorEvent, { error }, { raw: { error } }).catch(emitError => console.error('Failed to emit WebSocket error:', emitError))
      },
      message(_, message) {
        try {
          const inner = restoreInner(JSON.parse(message.text()))
          void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message } }).catch(emitError => console.error('Failed to emit WebSocket message:', emitError))
        }
        catch (error) {
          console.error('Failed to parse WebSocket message:', error)
          void ctx.emit(wsErrorEvent, { error }, { raw: { message } }).catch(emitError => console.error('Failed to emit WebSocket parse error:', emitError))
        }
      },
    },
    context: ctx,
  }
}
