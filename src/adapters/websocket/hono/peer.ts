import type { WSEvents } from 'hono/ws'

import type { HonoWsInvocableEventContext, HonoWsRawEventOptions } from './shared'

import { createContext as createBaseContext } from '../../../context'
import { emitInboundMessage, forwardOutboundEvents } from './internal'
import { wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './shared'

export interface CreatePeerHooksOptions {
  onContext?: (ctx: HonoWsInvocableEventContext) => void
}

export interface PeerHooksResult {
  hooks: WSEvents
}

/**
 * Creates Hono `WSEvents` hooks with one Eventa context per connected peer.
 *
 * Use when:
 * - A Hono route wants per-socket Eventa RPC handlers or per-peer fanout.
 *
 * Expects:
 * - The returned hooks are passed to Hono's `upgradeWebSocket(...)` helper.
 *
 * Returns:
 * - Hono websocket hooks. `options.onContext` receives the peer context after
 *   `onOpen`, when Hono exposes the `WSContext`.
 */
export function createPeerHooks(options: CreatePeerHooksOptions = {}): PeerHooksResult {
  let context: HonoWsInvocableEventContext | undefined
  let offOutbound: (() => void) | undefined

  const hooks: WSEvents = {
    onOpen(event, ws) {
      const ctx = createBaseContext<any, HonoWsRawEventOptions>()
      context = ctx

      offOutbound = forwardOutboundEvents(ctx, data => ws.send(data))

      ctx.emit(wsConnectedEvent, undefined, { raw: { open: event } })
      options.onContext?.(ctx)
    },

    onMessage(event) {
      if (!context) {
        return
      }

      void emitInboundMessage(context, event)
    },

    onClose(event) {
      if (!context) {
        return
      }

      context.abort(new Error('eventa: invoke cancelled, hono websocket disconnected'))
      context.emit(wsDisconnectedEvent, undefined, { raw: { close: event } })
      offOutbound?.()
      context = undefined
      offOutbound = undefined
    },

    onError(event) {
      if (!context) {
        return
      }

      context.abort(new Error('eventa: invoke cancelled, hono websocket error'))
      context.emit(wsErrorEvent, { error: event }, { raw: { error: event } })
    },
  }

  return { hooks }
}
