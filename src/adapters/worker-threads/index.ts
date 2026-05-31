import type { Transferable, Worker } from 'node:worker_threads'

import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { toError } from '../errors'
import { generateWorkerPayload, parseWorkerPayload } from '../webworkers/internal'
import { isWorkerEventa, normalizeOnListenerParameters, workerErrorEvent } from '../webworkers/shared'

export function createContext(worker: Worker) {
  const ctx = createBaseContext() as EventContext<
    {
      invokeRequest?: { transfer?: Transferable[] }
      invokeResponse?: { transfer?: Transferable[] }
    },
    { raw: { message?: unknown, error?: unknown, messageError?: unknown }, transfer?: Transferable[] }
  >

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event, options) => {
    const { body, transfer } = normalizeOnListenerParameters(event, options)
    const data = generateWorkerPayload(event.id, { ...defineOutboundEventa(event.type), ...event, body })
    if (transfer != null) {
      worker.postMessage(data, transfer as unknown as Transferable[])
      return
    }

    worker.postMessage(data)
  })

  worker.on('message', (message) => {
    try {
      const { type, payload } = parseWorkerPayload<Eventa<any>>(message)
      if (!isWorkerEventa(payload)) {
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { message } })
      }
      else {
        ctx.emit(defineInboundEventa(type), { message: payload.body }, { raw: { message } })
      }
    }
    catch (error) {
      console.error('Failed to parse Node worker message:', error)
      ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: node worker message parse error') }, { raw: { message } })
    }
  })

  worker.on('error', (event) => {
    // Fatal worker error. Abort lifetime so any in-flight invoke rejects;
    // emit the business event for non-invoke listeners.
    const error = toError(event, 'eventa: invoke cancelled, node worker error')
    ctx.abort(error)
    ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } })
  })

  worker.on('messageerror', (event) => {
    const error = toError(event, 'eventa: invoke cancelled, node worker messageerror')
    ctx.abort(error)
    ctx.emit(workerErrorEvent, { kind: 'messageerror', error, message: event }, { raw: { messageError: event } })
  })

  return {
    context: ctx,
  }
}

export { defineOutboundWorkerEventa, defineWorkerEventa, isWorkerEventa, workerErrorEvent } from '../webworkers/shared'
export type * from '../webworkers/shared'
