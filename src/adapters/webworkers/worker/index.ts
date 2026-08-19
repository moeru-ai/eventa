/* eslint-disable no-restricted-globals */
import type { CreateContextOptions, EventContext } from '../../../context'
import type { WorkerContextExtensions } from '../shared'

import { createContext as createBaseContext } from '../../../context'
import { and, EventaFlowDirection, matchBy } from '../../../eventa'
import { createOnceReporter, toError } from '../../errors'
import { createOutboundInner } from '../../internal'
import { createWorkerInnerEventa, restoreInner } from '../internal'
import { workerErrorEvent } from '../shared'

/** Creates an Eventa Context backed by a worker-global message port. */
export interface WebWorkerSelfAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** Worker-compatible port used for messaging. @default self */
  messagePort?: Omit<Worker, 'close' | 'start'>
}

/** Worker-global metadata and transferables available while emitting an Eventa. */
export interface WebWorkerSelfEmitOptions {
  raw: { event?: unknown, error?: string | Event }
  transfer?: Transferable[]
}

export function createContext(options?: WebWorkerSelfAdapterOptions) {
  const messagePort = options?.messagePort ?? self
  const ctx = createBaseContext<WorkerContextExtensions, WebWorkerSelfEmitOptions>(options?.context) as EventContext<WorkerContextExtensions, WebWorkerSelfEmitOptions>
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
      messagePort.postMessage(outgoing.inner, { transfer: outgoing.transfer })
      return
    }
    messagePort.postMessage(outgoing.inner)
  })

  messagePort.onmessage = (event: MessageEvent) => {
    try {
      const inner = restoreInner(event.data)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { event } }).catch(emitError => console.error('Failed to emit WebWorker message:', emitError))
    }
    catch (error) {
      reportParseError(error)
      void ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: webworker message parse error') }, { raw: { event } }).catch(emitError => console.error('Failed to emit WebWorker parse error:', emitError))
    }
  }
  messagePort.onerror = (event: ErrorEvent) => {
    // A fatal worker-side error terminates invokes owned by this context.
    const error = toError(event, 'eventa: invoke cancelled, webworker self error')
    stopSending()
    ctx.abort(error)
    void ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } }).catch(emitError => console.error('Failed to emit WebWorker error:', emitError))
  }

  return { context: ctx }
}

export { workerErrorEvent } from '../shared'
export type { AdapterErrorKind, AdapterErrorPayload } from '../shared'
