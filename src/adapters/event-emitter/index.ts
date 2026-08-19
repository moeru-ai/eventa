import type { CreateContextOptions } from '../../context'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOnceReporter } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'
import { errorEvent } from './shared'

function withRemoval(eventTarget: NodeJS.EventEmitter, type: string, listener: Parameters<NodeJS.EventEmitter['on']>[1]) {
  eventTarget.on(type, listener)
  return { remove: () => eventTarget.off(type, listener) }
}

/** Creates an Eventa Context backed by a Node.js EventEmitter. */
export interface EventEmitterAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** Event name carrying Eventa inner values, or `false` to disable ingress and egress. @default 'message' */
  messageEventName?: string | false
  /** Event name dispatched as adapter errors, or `false` to disable it. @default 'error' */
  errorEventName?: string | false
  /** Additional transport listeners removed when the adapter is disposed. @default {} */
  extraListeners?: Record<string, (...args: unknown[]) => void | Promise<void>>
}

/** Raw EventEmitter metadata exposed to Eventa listeners. */
export interface EventEmitterEmitOptions {
  raw: { event: unknown }
}

export function createContext(eventTarget: NodeJS.EventEmitter, options?: EventEmitterAdapterOptions) {
  const ctx = createBaseContext<undefined, EventEmitterEmitOptions>(options?.context)
  const {
    messageEventName = 'message',
    errorEventName = 'error',
    extraListeners = {},
  } = options || {}
  const cleanupRemoval: Array<{ remove: () => void }> = []
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse EventEmitter message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (messageEventName && inner) {
      eventTarget.emit(messageEventName, inner)
    }
  })

  if (messageEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, messageEventName, (event) => {
      try {
        const inner = restoreInner(event)
        void ctx.emit(inner.eventa, inner.eventa.body, { raw: { event } }).catch(emitError => console.error('Failed to emit EventEmitter message:', emitError))
      }
      catch (error) {
        reportParseError(error)
        void ctx.emit(errorEvent, { error }, { raw: { event } }).catch(emitError => console.error('Failed to emit EventEmitter parse error:', emitError))
      }
    }))
  }

  if (errorEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, errorEventName, (error) => {
      void ctx.emit(errorEvent, { error }, { raw: { event: error } }).catch(emitError => console.error('Failed to emit EventEmitter error:', emitError))
    }))
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    cleanupRemoval.push(withRemoval(eventTarget, eventName, listener))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      stopSending()
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, EventEmitter adapter disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
