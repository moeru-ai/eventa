import type { Transferable, Worker } from 'node:worker_threads'

import type { CreateContextOptions } from '../../context'
import type { WorkerContextExtensions } from '../webworkers/shared'

import { createContext as createBaseContext } from '../../context'
import { and, EventaFlowDirection, matchBy } from '../../eventa'
import { createOnceReporter, toError } from '../errors'
import { createOutboundInner } from '../internal'
import { createWorkerInnerEventa, restoreInner } from '../webworkers/internal'
import { workerErrorEvent } from '../webworkers/shared'

/** Creates an Eventa Context backed by a Node.js Worker. */
export interface WorkerThreadAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
}

/** Worker-thread metadata and transferables available while emitting an Eventa. */
export interface WorkerThreadEmitOptions {
  raw: { message?: unknown, error?: unknown, messageError?: unknown }
  transfer?: Transferable[]
}

export function createContext(worker: Worker, options?: WorkerThreadAdapterOptions) {
  const ctx = createBaseContext<WorkerContextExtensions, WorkerThreadEmitOptions>(options?.context)
  const reportParseError = createOnceReporter((error: unknown) => console.error('Failed to parse Node worker message:', error))
  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event, emitOptions) => {
    const inner = createOutboundInner(event)
    if (!inner) {
      return
    }
    const outgoing = createWorkerInnerEventa(inner, emitOptions)
    worker.postMessage(outgoing.inner, outgoing.transfer)
  })

  worker.on('message', (message) => {
    try {
      const inner = restoreInner(message)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message } }).catch(emitError => console.error('Failed to emit Node worker message:', emitError))
    }
    catch (error) {
      reportParseError(error)
      void ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: node worker message parse error') }, { raw: { message } }).catch(emitError => console.error('Failed to emit Node worker parse error:', emitError))
    }
  })
  worker.on('error', (event) => {
    // A fatal worker failure terminates invokes owned by this context.
    const error = toError(event, 'eventa: invoke cancelled, node worker error')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit Node worker error:', emitError))
  })
  worker.on('messageerror', (event) => {
    // The transport cannot reconstruct the message, so its lifetime is unusable.
    const error = toError(event, 'eventa: invoke cancelled, node worker messageerror')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'messageerror', error, message: event }, { raw: { messageError: event } }).catch(emitError => console.error('Failed to emit Node worker message error:', emitError))
  })

  return { context: ctx }
}

export { defineWorkerEventa, isWorkerEventa, workerErrorEvent } from '../webworkers/shared'
export type * from '../webworkers/shared'
