import type { CreateContextOptions } from '../../../context'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOutboundInner, restoreInner } from '../../internal'

export const wsConnectedEvent = defineEventa<{ url: string }>()
export const wsDisconnectedEvent = defineEventa<{ url: string }>()
export const wsErrorEvent = defineEventa<{ error: unknown }>()

/** Creates an Eventa Context backed by a native WebSocket. */
export interface NativeWebSocketAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

/** Raw native WebSocket metadata exposed to Eventa listeners. */
export interface NativeWebSocketEmitOptions {
  raw: { message?: MessageEvent, open?: Event, error?: Event, close?: CloseEvent }
}

export function createContext(wsConn: WebSocket, options?: NativeWebSocketAdapterOptions) {
  const ctx = createBaseContext<undefined, NativeWebSocketEmitOptions>(options?.context)
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (inner) {
      wsConn.send(JSON.stringify(inner))
    }
  })

  wsConn.onmessage = (event) => {
    try {
      const inner = restoreInner(JSON.parse(String(event.data)))
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }).catch(emitError => console.error('Failed to emit WebSocket message:', emitError))
    }
    catch (error) {
      // A malformed frame is recoverable; keep the socket lifetime alive.
      console.error('Failed to parse WebSocket message:', error)
      void ctx.emit(wsErrorEvent, { error }, { raw: { message: event } }).catch(emitError => console.error('Failed to emit WebSocket parse error:', emitError))
    }
  }
  wsConn.onopen = event => void ctx.emit(wsConnectedEvent, { url: wsConn.url }, { raw: { open: event } }).catch(emitError => console.error('Failed to emit WebSocket open event:', emitError))
  wsConn.onerror = (error) => {
    // Socket failure is fatal to pending invokes, unlike a malformed frame.
    stopSending()
    ctx.abort(new Error('eventa: invoke cancelled, websocket error'))
    void ctx.emit(wsErrorEvent, { error }, { raw: { error } }).catch(emitError => console.error('Failed to emit WebSocket error:', emitError))
  }
  wsConn.onclose = (close) => {
    stopSending()
    ctx.abort(new Error(`eventa: invoke cancelled, websocket disconnected (${wsConn.url})`))
    void ctx.emit(wsDisconnectedEvent, { url: wsConn.url }, { raw: { close } }).catch(emitError => console.error('Failed to emit WebSocket close event:', emitError))
  }

  return { context: ctx }
}
