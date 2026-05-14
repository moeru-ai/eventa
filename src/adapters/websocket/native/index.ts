import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { createContext as createBaseContext } from '../../../context'
import { and, defineEventa, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWebsocketPayload, parseWebsocketPayload } from '../internal'

export const wsConnectedEvent = defineEventa<{ url: string }>()
export const wsDisconnectedEvent = defineEventa<{ url: string }>()
export const wsErrorEvent = defineEventa<{ error: unknown }>()

export function createContext(wsConn: WebSocket) {
  const ctx = createBaseContext() as EventContext<any, { raw: { message?: any, open?: Event, error?: Event, close?: CloseEvent } }>

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const data = JSON.stringify(generateWebsocketPayload(event.id, { ...defineOutboundEventa(event.type), ...event }))
    wsConn.send(data)
  })

  wsConn.onmessage = (event) => {
    try {
      const { type, payload } = parseWebsocketPayload<Eventa<any>>(event.data)
      ctx.emit(defineInboundEventa(type), payload.body, { raw: { message: event } })
    }
    catch (error) {
      console.error('Failed to parse WebSocket message:', error)
      ctx.emit(wsErrorEvent, { error }, { raw: { message: event } })
    }
  }

  wsConn.onopen = (event) => {
    ctx.emit(wsConnectedEvent, { url: wsConn.url }, { raw: { open: event } })
  }

  wsConn.onerror = (error) => {
    // Socket-level error (not a per-message parse failure — those stay
    // recoverable in `onmessage` above). Abort lifetime so any in-flight
    // invoke rejects; emit the business event for non-invoke listeners.
    ctx.abort(new Error('eventa: invoke cancelled, websocket error'))
    ctx.emit(wsErrorEvent, { error }, { raw: { error } })
  }

  wsConn.onclose = (close) => {
    ctx.abort(new Error(`eventa: invoke cancelled, websocket disconnected (${wsConn.url})`))
    ctx.emit(wsDisconnectedEvent, { url: wsConn.url }, { raw: { close } })
  }

  return {
    context: ctx,
  }
}
