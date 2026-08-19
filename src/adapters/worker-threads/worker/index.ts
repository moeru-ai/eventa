import type { MessagePort, Transferable } from 'node:worker_threads'

import type { CreateContextOptions, EventContext } from '../../../context'
import type { WorkerContextExtensions } from '../../webworkers/shared'

import { parentPort } from 'node:worker_threads'

import { createContext as createBaseContext } from '../../../context'
import { and, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOnceReporter, toError } from '../../errors'
import { createOutboundInner } from '../../internal'
import { createWorkerInnerEventa, restoreInner } from '../../webworkers/internal'
import { workerErrorEvent } from '../../webworkers/shared'

/** Creates an Eventa Context backed by a Node.js worker MessagePort. */
export interface WorkerThreadSelfAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** Message port used for worker communication. @default parentPort */
  messagePort?: MessagePort
}

/** Worker-side metadata and transferables available while emitting an Eventa. */
export interface WorkerThreadSelfEmitOptions {
  raw: { message?: unknown, error?: unknown, messageError?: unknown }
  transfer?: Transferable[]
}

export function createContext(options?: WorkerThreadSelfAdapterOptions) {
  const messagePort = options?.messagePort ?? parentPort
  if (!messagePort) {
    throw new Error('Node worker context requires a MessagePort (parentPort is null).')
  }

  const ctx = createBaseContext<WorkerContextExtensions, WorkerThreadSelfEmitOptions>(options?.context) as EventContext<WorkerContextExtensions, WorkerThreadSelfEmitOptions>
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
    if (outgoing.transfer != null) {
      messagePort.postMessage(outgoing.inner, outgoing.transfer)
      return
    }
    messagePort.postMessage(outgoing.inner)
  })

  messagePort.on('message', (message) => {
    try {
      const inner = restoreInner(message)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message } }).catch(emitError => console.error('Failed to emit Node worker message:', emitError))
    }
    catch (error) {
      reportParseError(error)
      void ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: node worker message parse error') }, { raw: { message } }).catch(emitError => console.error('Failed to emit Node worker parse error:', emitError))
    }
  })
  messagePort.on('error', (event) => {
    // A fatal port error terminates invokes owned by this context.
    const error = toError(event, 'eventa: invoke cancelled, node worker port error')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit Node worker error:', emitError))
  })
  messagePort.on('messageerror', (event) => {
    // The transport cannot reconstruct the message, so its lifetime is unusable.
    const error = toError(event, 'eventa: invoke cancelled, node worker messageerror')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'messageerror', error, message: event }, { raw: { messageError: event } }).catch(emitError => console.error('Failed to emit Node worker message error:', emitError))
  })

  return { context: ctx }
}

export { workerErrorEvent } from '../../webworkers/shared'
export type { AdapterErrorKind, AdapterErrorPayload } from '../../webworkers/shared'
