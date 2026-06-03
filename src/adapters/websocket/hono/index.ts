import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws'

import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'
import type { InvocableEventContext } from '../../../invoke'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWebsocketPayload, parseWebsocketPayload } from '../internal'

export const wsConnectedEvent = defineEventa('eventa:adapters:hono-ws:connected')
export const wsDisconnectedEvent = defineEventa('eventa:adapters:hono-ws:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:hono-ws:error')

type HonoWsOpenEvent = Parameters<NonNullable<WSEvents['onOpen']>>[0]
type HonoWsMessageEvent = Parameters<NonNullable<WSEvents['onMessage']>>[0]
type HonoWsCloseEvent = Parameters<NonNullable<WSEvents['onClose']>>[0]
type HonoWsErrorEvent = Parameters<NonNullable<WSEvents['onError']>>[0]

export interface HonoWsRawEventOptions {
  raw?: {
    close?: HonoWsCloseEvent
    error?: HonoWsErrorEvent
    message?: HonoWsMessageEvent
    open?: HonoWsOpenEvent
  }
}

export type HonoWsEventContext = EventContext<any, HonoWsRawEventOptions>
export type HonoWsInvocableEventContext = InvocableEventContext<any, HonoWsRawEventOptions>

export interface CreatePeerHooksOptions {
  onContext?: (ctx: HonoWsInvocableEventContext) => void
}

export interface PeerHooksResult {
  hooks: WSEvents
}

export interface GlobalHooksResult {
  context: HonoWsEventContext
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

function forwardOutboundEvents(
  context: HonoWsEventContext,
  send: (data: string) => void,
): () => void {
  return context.on(and(
    matchBy((event: DirectionalEventa<any>) => event._flowDirection === EventaFlowDirection.Outbound || !event._flowDirection),
    matchBy('*'),
  ), (event) => {
    const data = JSON.stringify(generateWebsocketPayload(event.id, { ...defineOutboundEventa(event.type), ...event }))
    send(data)
  })
}

async function emitInboundMessage(
  context: HonoWsEventContext,
  event: HonoWsMessageEvent,
): Promise<void> {
  try {
    const raw = await readMessageText(event.data)
    const { type, payload } = parseWebsocketPayload<Eventa<any>>(raw)
    context.emit(defineInboundEventa(type), payload.body, { raw: { message: event } })
  }
  catch (error) {
    // Per-message parse failure is recoverable; keep the socket lifetime alive.
    console.error('Failed to parse WebSocket message:', error)
    context.emit(wsErrorEvent, { error }, { raw: { message: event } })
  }
}

async function readMessageText(data: WSMessageReceive): Promise<string> {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof Blob) {
    return data.text()
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data)
  }

  throw new TypeError('Unsupported Hono websocket message payload')
}
