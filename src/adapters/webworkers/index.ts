import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generateWorkerPayload, parseWorkerPayload } from './internal'
import { isWorkerEventa, normalizeOnListenerParameters, workerErrorEvent } from './shared'

export function createContext(worker: Worker) {
  const ctx = createBaseContext() as EventContext<
    {
      invokeRequest?: { transfer?: Transferable[] }
      invokeResponse?: { transfer?: Transferable[] }
    },
    { raw: { message?: MessageEvent, error?: ErrorEvent, messageError?: MessageEvent }, transfer?: Transferable[] }
  >

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event, options) => {
    const { body, transfer } = normalizeOnListenerParameters(event, options)
    const data = generateWorkerPayload(event.id, { ...defineOutboundEventa(event.type), ...event, body })
    if (transfer != null) {
      worker.postMessage(data, { transfer })
      return
    }

    worker.postMessage(data)
  })

  worker.onmessage = (event) => {
    try {
      const { type, payload } = parseWorkerPayload<Eventa<any>>(event.data)
      if (!isWorkerEventa(payload)) {
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { message: event } })
      }
      else {
        ctx.emit(defineInboundEventa(type), { message: payload.body }, { raw: { message: event } })
      }
    }
    catch (error) {
      console.error('Failed to parse WebWorker message:', error)
      ctx.emit(workerErrorEvent, { error }, { raw: { message: event } })
    }
  }

  worker.onerror = (error) => {
    ctx.emit(workerErrorEvent, { error }, { raw: { error } })
  }

  worker.onmessageerror = (error) => {
    ctx.emit(workerErrorEvent, { error }, { raw: { messageError: error } })
  }

  return {
    context: ctx,
  }
}

export { defineOutboundWorkerEventa, defineWorkerEventa, isWorkerEventa, withTransfer } from './shared'
export type * from './shared'
