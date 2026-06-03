import type { WSMessageReceive } from 'hono/ws'

import type { DirectionalEventa, Eventa } from '../../../eventa'
import type { HonoWsEventContext, HonoWsMessageEvent } from './shared'

import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWebsocketPayload, parseWebsocketPayload } from '../internal'
import { wsErrorEvent } from './shared'

export function forwardOutboundEvents(
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

export async function emitInboundMessage(
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
