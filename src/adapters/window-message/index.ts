import type { CreateContextOptions } from '../../context'
import type { EventaInner } from '../../internal'
import type { WindowMessageEnvelope } from './shared'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOnceReporter, toError } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

function withRemoval<K extends keyof WindowEventMap>(currentWindow: Window, type: K, listener: (event: WindowEventMap[K]) => void) {
  currentWindow.addEventListener(type, listener)
  return { remove: () => currentWindow.removeEventListener(type, listener) }
}

function isEnvelope(value: unknown, channel: string): value is WindowMessageEnvelope<EventaInner> {
  return typeof value === 'object'
    && value !== null
    && '__eventa' in value
    && value.__eventa === true
    && 'channel' in value
    && value.channel === channel
    && 'sourceId' in value
    && typeof value.sourceId === 'string'
    && 'payload' in value
}

function matchOrigin(expectedOrigin: string | ((origin: string) => boolean), origin: string) {
  return typeof expectedOrigin === 'function' ? expectedOrigin(origin) : expectedOrigin === origin
}

/** Creates an Eventa Context backed by a window-message channel. */
export interface WindowMessageAdapterOptions {
  channel: string
  currentWindow: Window
  targetWindow: () => Window | null | undefined
  context?: CreateContextOptions
  expectedSource?: () => MessageEventSource | null | undefined
  targetOrigin?: string
  expectedOrigin?: string | ((origin: string) => boolean)
  acceptMessage?: (event: MessageEvent<unknown>) => boolean
  messageEvents?: boolean
  messageErrorEvents?: boolean
}

/** Raw window-message metadata exposed to Eventa listeners. */
export interface WindowMessageEmitOptions {
  raw: { message?: MessageEvent, messageError?: MessageEvent, error?: unknown }
}

export function createContext(options: WindowMessageAdapterOptions) {
  const ctx = createBaseContext<undefined, WindowMessageEmitOptions>(options.context)
  const sourceId = crypto.randomUUID()
  const { messageEvents: message = true, messageErrorEvents: messageError = true } = options
  const cleanupRemoval: Array<{ remove: () => void }> = []
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse window message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    options.targetWindow()?.postMessage({
      __eventa: true,
      channel: options.channel,
      sourceId,
      payload: inner,
    } satisfies WindowMessageEnvelope<EventaInner>, options.targetOrigin ?? '*')
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
      if (event.data.sourceId === sourceId || (options.acceptMessage && !options.acceptMessage(event))) {
        return
      }

      try {
        const inner = restoreInner(event.data.payload)
        void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }).catch(emitError => console.error('Failed to emit window message:', emitError))
      }
      catch (error) {
        reportParseError(error)
        void ctx.emit(errorEvent, { kind: 'parse', error: toError(error, 'eventa: window message parse error') }, { raw: { error } }).catch(emitError => console.error('Failed to emit window-message parse error:', emitError))
      }
    }))
  }

  if (messageError) {
    cleanupRemoval.push(withRemoval(options.currentWindow, 'messageerror', (event) => {
      void ctx.emit(errorEvent, { kind: 'messageerror', error: toError(event, 'eventa: window messageerror'), message: event }, { raw: { messageError: event } }).catch(emitError => console.error('Failed to emit window message error:', emitError))
    }))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      stopSending()
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, window message adapter disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export { errorEvent } from './shared'
export type * from './shared'
