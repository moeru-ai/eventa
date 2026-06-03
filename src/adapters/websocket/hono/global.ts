import type { WSContext, WSEvents } from 'hono/ws'

import type { HonoWsEventContext, HonoWsRawEventOptions } from './shared'

import { createContext as createBaseContext } from '../../../context'
import { emitInboundMessage, forwardOutboundEvents } from './internal'
import { wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './shared'

export interface GlobalHooksResult {
  context: HonoWsEventContext
  hooks: WSEvents
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
export function createGlobalHooks(): GlobalHooksResult {
  const context = createBaseContext<any, HonoWsRawEventOptions>()
  const peers = new Set<WSContext>()

  forwardOutboundEvents(context, (data) => {
    for (const peer of peers) {
      peer.send(data)
    }
  })

  const hooks: WSEvents = {
    onOpen(event, ws) {
      peers.add(ws)
      context.emit(wsConnectedEvent, undefined, { raw: { open: event } })
    },

    onMessage(event) {
      void emitInboundMessage(context, event)
    },

    onClose(event, ws) {
      peers.delete(ws)
      context.emit(wsDisconnectedEvent, undefined, { raw: { close: event } })
    },

    onError(event) {
      context.emit(wsErrorEvent, { error: event }, { raw: { error: event } })
    },
  }

  return { context, hooks }
}
