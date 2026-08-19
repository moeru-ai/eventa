import type { CreateContextOptions } from '../../context'
import type { WorkerContextExtensions } from './shared'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOnceReporter, toError } from '../errors'
import { createOutboundInner } from '../internal'
import { createWorkerInnerEventa, restoreInner } from './internal'
import { workerErrorEvent } from './shared'

/** Creates an Eventa Context backed by a browser Worker. */
export interface WebWorkerAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

/** Worker metadata and transferables available while emitting an Eventa. */
export interface WebWorkerEmitOptions {
  raw: { message?: MessageEvent, error?: ErrorEvent, messageError?: MessageEvent }
  transfer?: Transferable[]
}

export function createContext(worker: Worker, options?: WebWorkerAdapterOptions) {
  const ctx = createBaseContext<WorkerContextExtensions, WebWorkerEmitOptions>(options?.context)
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse WebWorker message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event, emitOptions) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    const outgoing = createWorkerInnerEventa(inner, emitOptions)
    if (outgoing.transfer != null) {
      worker.postMessage(outgoing.inner, { transfer: outgoing.transfer })
      return
    }
    worker.postMessage(outgoing.inner)
  })

  worker.onmessage = (event) => {
    try {
      const inner = restoreInner(event.data)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message: event } }).catch(emitError => console.error('Failed to emit WebWorker message:', emitError))
    }
    catch (error) {
      reportParseError(error)
      void ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: webworker message parse error') }, { raw: { message: event } }).catch(emitError => console.error('Failed to emit WebWorker parse error:', emitError))
    }
  }
  worker.onerror = (event) => {
    // Load, syntax, and runtime worker failures terminate pending invokes.
    const error = toError(event, 'eventa: invoke cancelled, webworker error')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit WebWorker error:', emitError))
  }
  worker.onmessageerror = (event) => {
    // The transport cannot reconstruct the message, so its lifetime is unusable.
    const error = toError(event, 'eventa: invoke cancelled, webworker messageerror')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'messageerror', error, message: event }, { raw: { messageError: event } }).catch(emitError => console.error('Failed to emit WebWorker message error:', emitError))
  }

  return { context: ctx }
}

export { defineWorkerEventa, isWorkerEventa, workerErrorEvent } from './shared'
export type * from './shared'
