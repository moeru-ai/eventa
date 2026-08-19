import type { WSContext, WSEvents } from 'hono/ws'

import type { CreateContextOptions } from '../../../context'
import type { WebSocketProtocolGuard } from '../protocol'
import type { HonoWsEventContext, HonoWsMessageEvent, HonoWsRawEventOptions } from './shared'

import { createContext as createBaseContext } from '../../../context'
import { and, defineInboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'
import { createWebSocketProtocolGuard } from '../protocol'
import { readMessageText } from './internal'
import { wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './shared'

const inboundWsErrorEvent = defineInboundEventa<{ error: unknown }>(wsErrorEvent.id)

export interface GlobalHooksResult {
  context: HonoWsEventContext
  hooks: WSEvents
}

export interface CreateGlobalHooksOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

/**
 * Creates Hono `WSEvents` hooks backed by one shared broadcasting context.
 *
 * Use when:
 * - A server needs one Eventa context that broadcasts outbound events to every
 *   connected Hono WebSocket peer.
 *
 * Expects:
 * - Connected peers accept the standard Eventa websocket JSON wire format.
 *
 * Returns:
 * - A shared context plus Hono websocket hooks.
 */
export function createGlobalHooks(options: CreateGlobalHooksOptions = {}): GlobalHooksResult {
  const context = createBaseContext<undefined, HonoWsRawEventOptions>(options.context)
  const peers = new Set<WSContext>()
  const protocolGuards = new WeakMap<WSContext, WebSocketProtocolGuard<HonoWsMessageEvent>>()

  context.on(and(
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

  const hooks: WSEvents = {
    onOpen(event, ws) {
      peers.add(ws)
      protocolGuards.set(ws, createWebSocketProtocolGuard<HonoWsMessageEvent>({
        close: (code, reason) => ws.close(code, reason),
        onRejected(error, event) {
          peers.delete(ws)
          // This transport error belongs to the local server context. Marking
          // it inbound keeps the global outbound bridge from broadcasting one
          // incompatible peer's failure to every healthy peer.
          void context.emit(inboundWsErrorEvent, { error }, { raw: { message: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket parse error:', emitError))
        },
      }))
      void context.emit(wsConnectedEvent, undefined, { raw: { open: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket open event:', emitError))
    },

    onMessage(event, ws) {
      const protocolGuard = protocolGuards.get(ws)
      if (!protocolGuard || protocolGuard.rejected) {
        return
      }

      void readMessageText(event.data)
        .then(message => restoreInner(JSON.parse(message)))
        .then(
          (inner) => {
            if (protocolGuard.rejected) {
              return
            }
            return context.emit(inner.eventa, inner.eventa.body, { raw: { message: event } })
          },
          (error) => {
            protocolGuard.reject(error, event)
          },
        )
        .catch(emitError => console.error('Failed to emit Hono WebSocket message:', emitError))
    },

    onClose(event, ws) {
      peers.delete(ws)
      protocolGuards.delete(ws)
      void context.emit(wsDisconnectedEvent, undefined, { raw: { close: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket close event:', emitError))
    },

    onError(event) {
      void context.emit(wsErrorEvent, { error: event }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket error:', emitError))
    },
  }

  return { context, hooks }
}
