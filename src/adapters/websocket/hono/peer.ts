import type { WSEvents } from 'hono/ws'

import type { CreateContextOptions } from '../../../context'
import type { HonoWsInvocableEventContext, HonoWsRawEventOptions } from './shared'

import { createContext as createBaseContext } from '../../../context'
import { and, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'
import { readMessageText } from './internal'
import { wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './shared'

export interface CreatePeerHooksOptions {
  /** Delivery deduplication and hop policy for each created Context. */
  context?: CreateContextOptions
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
  let stopSending: (() => void) | undefined

  const hooks: WSEvents = {
    onOpen(event, ws) {
      const ctx = createBaseContext<undefined, HonoWsRawEventOptions>(options.context)
      context = ctx

      stopSending = ctx.on(and(
        matchBy(eventa => !('_flowDirection' in eventa) || !eventa._flowDirection || eventa._flowDirection === EventaFlowDirection.Outbound),
        matchBy('*'),
      ), (eventa) => {
        const inner = createOutboundInner(eventa)
        if (inner) {
          ws.send(JSON.stringify(inner))
        }
      })

      void ctx.emit(wsConnectedEvent, undefined, { raw: { open: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket open event:', emitError))
      options.onContext?.(ctx)
    },

    onMessage(event) {
      if (!context) {
        return
      }
      const currentContext = context

      void readMessageText(event.data)
        .then(message => restoreInner(JSON.parse(message)))
        .then(
          inner => currentContext.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }),
          (error) => {
            console.error('Failed to parse WebSocket message:', error)
            return currentContext.emit(wsErrorEvent, { error }, { raw: { message: event } })
          },
        )
        .catch(emitError => console.error('Failed to emit Hono WebSocket message:', emitError))
    },

    onClose(event) {
      if (!context) {
        return
      }

      stopSending?.()
      context.abort(new Error('eventa: invoke cancelled, hono websocket disconnected'))
      void context.emit(wsDisconnectedEvent, undefined, { raw: { close: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket close event:', emitError))
      context = undefined
      stopSending = undefined
    },

    onError(event) {
      if (!context) {
        return
      }

      stopSending?.()
      context.abort(new Error('eventa: invoke cancelled, hono websocket error'))
      void context.emit(wsErrorEvent, { error: event }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit Hono WebSocket error event:', emitError))
    },
  }

  return { hooks }
}
