import type { EventContext } from './context'
import type { Eventa, EventaMatchExpression } from './eventa'

/**
 * Internal invoke configuration carried on context extensions.
 *
 * Known usage: worker adapters (webworkers/worker-threads) use this to
 * abort pending invokes when the worker emits a fatal error event.
 */
export interface InvokeInternalConfig<EO = any> {
  abortOnEvents?: Array<Eventa<any> | EventaMatchExpression<any>>
  mapAbortError?: (payload: Eventa<any>, options?: EO) => unknown
}

/**
 * Read the internal invoke configuration from context extensions, if present.
 * This is used by defineInvoke to determine which events should abort inflight invokes.
 */
export function getContextExtensionInvokeInternalConfig<EO = any>(ctx: EventContext<any, EO>): InvokeInternalConfig<EO> | undefined {
  const extensions = (ctx as EventContext<any, EO> & { extensions?: any }).extensions
  if (!extensions || typeof extensions !== 'object') {
    return undefined
  }

  const internal = extensions.__internal
  if (!internal || typeof internal !== 'object') {
    return undefined
  }

  const invoke = internal.invoke
  if (!invoke || typeof invoke !== 'object') {
    return undefined
  }

  return invoke as InvokeInternalConfig<EO>
}

/**
 * Register a fatal event/match expression that should terminate pending invokes.
 * Adapters call this to wire their error events (e.g. worker error) into invoke.
 */
export function registerInvokeAbortEventListeners<EO = any>(
  ctx: EventContext<any, EO>,
  eventOrMatch: Eventa<any> | EventaMatchExpression<any>,
): InvokeInternalConfig<EO> {
  const extensions = ((ctx as EventContext<any, EO> & { extensions?: any }).extensions ?? {}) as Record<string, any>
  const internal = (extensions.__internal ?? {}) as Record<string, any>
  const invokeInternal = (internal.invoke ?? {}) as Record<string, any>
  const abortOnEvents = Array.isArray(invokeInternal.abortOnEvents) ? invokeInternal.abortOnEvents : []

  if (!abortOnEvents.includes(eventOrMatch)) {
    abortOnEvents.push(eventOrMatch)
  }

  invokeInternal.abortOnEvents = abortOnEvents
  internal.invoke = invokeInternal
  extensions.__internal = internal
  ;(ctx as EventContext<any, EO> & { extensions?: any }).extensions = extensions

  return invokeInternal as InvokeInternalConfig<EO>
}
