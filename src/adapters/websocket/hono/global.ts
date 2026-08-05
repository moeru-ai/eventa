import type { WSContext, WSEvents } from 'hono/ws'

import type { CreateContextOptions } from '../../../context'
import type { HonoWsEventContext, HonoWsRawEventOptions } from './shared'

import { createContext as createBaseContext } from '../../../context'
import { and, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'
import { readMessageText } from './internal'
import { wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './shared'

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
      void context.emit(wsConnectedEvent, undefined, { raw: { open: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket open event:', emitError))
    },

    onMessage(event) {
      void readMessageText(event.data)
        .then(message => restoreInner(JSON.parse(message)))
        .then(
          inner => context.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }),
          (error) => {
            console.error('Failed to parse WebSocket message:', error)
            return context.emit(wsErrorEvent, { error }, { raw: { message: event } })
          },
        )
        .catch(emitError => console.error('Failed to emit Hono WebSocket message:', emitError))
    },

    onClose(event, ws) {
      peers.delete(ws)
      void context.emit(wsDisconnectedEvent, undefined, { raw: { close: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket close event:', emitError))
    },

    onError(event) {
      void context.emit(wsErrorEvent, { error: event }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket error:', emitError))
    },
  }

  return { context, hooks }
}
