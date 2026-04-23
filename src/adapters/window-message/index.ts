import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'
import type { WindowMessageEnvelope } from './shared'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

function withRemoval<K extends keyof WindowEventMap>(currentWindow: Window, type: K, listener: (event: WindowEventMap[K]) => void) {
  currentWindow.addEventListener(type, listener)

  return {
    remove: () => {
      currentWindow.removeEventListener(type, listener)
    },
  }
}

function isEnvelope(value: unknown, channel: string): value is WindowMessageEnvelope<Eventa<any>> {
  return typeof value === 'object'
    && value !== null
    && '__eventa' in value
    && value.__eventa === true
    && 'channel' in value
    && value.channel === channel
    && 'sourceId' in value
    && typeof value.sourceId === 'string'
    && 'payload' in value
    && typeof value.payload === 'object'
    && value.payload !== null
}

function matchOrigin(expectedOrigin: string | ((origin: string) => boolean), origin: string) {
  if (typeof expectedOrigin === 'function') {
    return expectedOrigin(origin)
  }

  return expectedOrigin === origin
}

export interface WindowMessageAdapterOptions {
  channel: string
  currentWindow: Window
  targetWindow: () => Window | null | undefined
  expectedSource?: () => MessageEventSource | null | undefined
  targetOrigin?: string
  expectedOrigin?: string | ((origin: string) => boolean)
  acceptMessage?: (event: MessageEvent<unknown>) => boolean
  messageEvents?: boolean
  messageErrorEvents?: boolean
}

export function createContext(options: WindowMessageAdapterOptions) {
  const ctx = createBaseContext() as EventContext<any, { raw: { message?: MessageEvent, messageError?: MessageEvent, error?: unknown } }>
  const sourceId = crypto.randomUUID()

  const {
    messageEvents: message = true,
    messageErrorEvents: messageError = true,
  } = options

  const cleanupRemoval: Array<{ remove: () => void }> = []

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const targetWindow = options.targetWindow()
    if (!targetWindow) {
      return
    }

    const payload = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })
    targetWindow.postMessage({
      __eventa: true,
      channel: options.channel,
      sourceId,
      payload,
    } satisfies WindowMessageEnvelope<Eventa<any>>, options.targetOrigin ?? '*')
  })

  if (message) {
    cleanupRemoval.push(withRemoval(options.currentWindow, 'message', (event) => {
      if (!isEnvelope(event.data, options.channel)) {
        return
      }

      const expectedSource = options.expectedSource?.()
      if (expectedSource && event.source !== expectedSource) {
        return
      }

      if (options.expectedOrigin && !matchOrigin(options.expectedOrigin, event.origin)) {
        return
      }

      if (event.data.sourceId === sourceId) {
        return
      }

      if (options.acceptMessage && !options.acceptMessage(event)) {
        return
      }

      try {
        const { type, payload } = parsePayload<Eventa<any>>(event.data.payload)
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { message: event } })
      }
      catch (error) {
        console.error('Failed to parse window message:', error)
        ctx.emit(errorEvent, { error }, { raw: { error } })
      }
    }))
  }

  if (messageError) {
    cleanupRemoval.push(withRemoval(options.currentWindow, 'messageerror', (event) => {
      ctx.emit(errorEvent, { error: event }, { raw: { messageError: event } })
    }))
  }

  return {
    context: ctx,
    dispose: () => {
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
