import type { Hooks, Message, Peer } from 'crossws'

import type { CreateContextOptions, EventContext } from '../../../context'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'
import { createWebSocketProtocolGuard } from '../protocol'

export const wsConnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-peer:connected')
export const wsDisconnectedEvent = defineEventa<{ id: string }>('eventa:adapters:websocket-peer:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:websocket-peer:error')

/** Creates an Eventa Context for one H3 WebSocket peer. */
export interface H3PeerAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

export function createPeerContext(peer: Peer, options?: H3PeerAdapterOptions): {
  hooks: Pick<Hooks, 'message' | 'close' | 'error'>
  context: EventContext<undefined, { raw: { message: Message } }>
} {
  interface EmitOptions { raw: { message: Message } }
  const peerId = peer.id
  const ctx = createBaseContext<undefined, EmitOptions>(options?.context)
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (inner) {
      peer.send(JSON.stringify(inner))
    }
  })
  const protocolGuard = createWebSocketProtocolGuard<Message>({
    close: (code, reason) => peer.close(code, reason),
    onRejected(error, message) {
      stopSending()
      void ctx.emit(wsErrorEvent, { error }, { raw: { message } }).catch(emitError => console.error('Failed to emit WebSocket peer parse error:', emitError))
      ctx.abort(new Error('eventa: invoke cancelled, unsupported websocket protocol'))
    },
  })

  return {
    hooks: {
      message(incomingPeer, message) {
        // crossws invokes shared hooks for every peer; this context owns one peer.
        if (incomingPeer.id !== peerId) {
          return
        }
        if (protocolGuard.rejected) {
          return
        }
        try {
          const inner = restoreInner(JSON.parse(message.text()))
          void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message } }).catch(emitError => console.error('Failed to emit WebSocket peer message:', emitError))
        }
        catch (error) {
          protocolGuard.reject(error, message)
        }
      },
      close(incomingPeer, details) {
        // crossws invokes shared hooks for every peer; ignore other peer closures.
        if (incomingPeer.id !== peerId) {
          return
        }
        const reasonText = details.reason ? ` (${details.reason})` : ''
        // Reject server-side invokes that would otherwise wait on a closed peer.
        stopSending()
        ctx.abort(new Error(`eventa: invoke cancelled, peer disconnected${reasonText}`))
        void ctx.emit(wsDisconnectedEvent, { id: peerId }).catch(emitError => console.error('Failed to emit WebSocket peer close event:', emitError))
      },
      error(incomingPeer, error) {
        if (incomingPeer.id !== peerId) {
          return
        }
        stopSending()
        ctx.abort(error instanceof Error ? error : new Error('eventa: invoke cancelled, peer error'))
        void ctx.emit(wsErrorEvent, { error }).catch(emitError => console.error('Failed to emit WebSocket peer error:', emitError))
      },
    },
    context: ctx,
  }
}

export interface PeerContext { peer: Peer, context: EventContext<undefined, { raw: { message: Message } }> }

export function createPeerHooks(options?: H3PeerAdapterOptions): { hooks: Partial<Hooks>, untilLeastOneConnected: Promise<PeerContext> } {
  let resolve: (value: PeerContext) => void
  const untilLeastOneConnected = new Promise<PeerContext>((r) => {
    resolve = r
  })
  // NOTICE:
  // These hook references are replaced when another peer connects, so this
  // helper serves only the most recently opened peer. Multi-peer ownership
  // requires a peer-id keyed registry and a different connection API.
  // Source/context: crossws exposes one shared hook set for all connected peers.
  // Remove this notice when createPeerHooks owns such a registry.
  let message: Hooks['message'] | undefined
  let close: Hooks['close'] | undefined
  let error: Hooks['error'] | undefined

  const hooks: Pick<Hooks, 'open' | 'message' | 'close' | 'error'> = {
    open: (peer) => {
      const peerContext = createPeerContext(peer, options)
      message = peerContext.hooks.message
      close = peerContext.hooks.close
      error = peerContext.hooks.error
      resolve({ peer, context: peerContext.context })
    },
    message: (peer, msg) => message?.(peer, msg),
    close: (peer, details) => close?.(peer, details),
    error: (peer, err) => error?.(peer, err),
  }

  return { hooks, untilLeastOneConnected }
}
