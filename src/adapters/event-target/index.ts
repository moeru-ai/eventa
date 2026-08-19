import type { CreateContextOptions } from '../../context'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, EventaType, matchBy } from '../../eventa'
import { createOnceReporter, toError } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'
import { adapterErrorEvent } from './shared'

function withRemoval(eventTarget: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null) {
  eventTarget.addEventListener(type, listener)
  return { remove: () => eventTarget.removeEventListener(type, listener) }
}

/** Creates an Eventa Context backed by an EventTarget. */
export interface EventTargetAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** DOM event name carrying Eventa inner values, or `false` to disable ingress. @default 'message' */
  messageEventName?: string | false
  /** DOM event name dispatched as adapter errors, or `false` to disable it. @default 'error' */
  errorEventName?: string | false
  /** Additional DOM listeners removed when the adapter is disposed. @default {} */
  extraListeners?: Record<string, (event: Event) => void | Promise<void>>
}

/** Raw EventTarget metadata exposed to Eventa listeners. */
export interface EventTargetEmitOptions {
  raw: { event: CustomEvent | Event | unknown }
}

export function createContext(eventTarget: EventTarget, options?: EventTargetAdapterOptions) {
  const ctx = createBaseContext<undefined, EventTargetEmitOptions>(options?.context)
  const {
    messageEventName = 'message',
    errorEventName = 'error',
    extraListeners = {},
  } = options || {}
  const cleanupRemoval: Array<{ remove: () => void }> = []
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse EventTarget message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    eventTarget.dispatchEvent(new CustomEvent(messageEventName || EventaType.Event, {
      detail: inner,
      bubbles: true,
      cancelable: true,
    }))
  })

  if (messageEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, messageEventName, (event) => {
      try {
        const inner = restoreInner((event as CustomEvent).detail)
        void ctx.emit(inner.eventa, inner.eventa.body, { raw: { event } }).catch(emitError => console.error('Failed to emit EventTarget message:', emitError))
      }
      catch (error) {
        reportParseError(error)
        void ctx.emit(adapterErrorEvent, { kind: 'parse', error: toError(error, 'eventa: EventTarget message parse error') }, { raw: { event } }).catch(emitError => console.error('Failed to emit EventTarget parse error:', emitError))
      }
    }))
  }

  if (errorEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, errorEventName, (event) => {
      void ctx.emit(adapterErrorEvent, { kind: 'fatal', error: toError(event, 'eventa: EventTarget error') }, { raw: { event } }).catch(emitError => console.error('Failed to emit EventTarget error:', emitError))
    }))
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    cleanupRemoval.push(withRemoval(eventTarget, eventName, listener))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      stopSending()
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, EventTarget adapter disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export { adapterErrorEvent } from './shared'
export type * from './shared'
