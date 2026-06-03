import type { WSEvents } from 'hono/ws'

import type { EventContext } from '../../../context'
import type { InvocableEventContext } from '../../../invoke'

import { defineEventa } from '../../../eventa'

export const wsConnectedEvent = defineEventa('eventa:adapters:hono-ws:connected')
export const wsDisconnectedEvent = defineEventa('eventa:adapters:hono-ws:disconnected')
export const wsErrorEvent = defineEventa<{ error: unknown }>('eventa:adapters:hono-ws:error')

export type HonoWsOpenEvent = Parameters<NonNullable<WSEvents['onOpen']>>[0]
export type HonoWsMessageEvent = Parameters<NonNullable<WSEvents['onMessage']>>[0]
export type HonoWsCloseEvent = Parameters<NonNullable<WSEvents['onClose']>>[0]
export type HonoWsErrorEvent = Parameters<NonNullable<WSEvents['onError']>>[0]

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
