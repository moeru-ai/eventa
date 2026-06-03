/* eslint-disable no-restricted-globals */
import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { createContext as createBaseContext } from '../../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { toError } from '../../errors'
import { generateWorkerPayload, parseWorkerPayload } from '../internal'
import { isWorkerEventa, normalizeOnListenerParameters, workerErrorEvent } from '../shared'

export function createContext(options?: {
  messagePort?: Omit<Worker, 'close' | 'start'>
}) {
  const {
    messagePort = self,
  } = options || {}

  const ctx = createBaseContext() as EventContext<
    {
      invokeRequest?: { transfer?: Transferable[] }
      invokeResponse?: { transfer?: Transferable[] }
    },
    {
      raw: { event?: any, error?: string | Event }
      transfer?: Transferable[]
    }
  >

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event, options) => {
    const { body, transfer } = normalizeOnListenerParameters(event, options)
    const data = generateWorkerPayload(event.id, { ...defineOutboundEventa(event.type), ...event, body })
    if (transfer != null) {
      messagePort.postMessage(data, { transfer })
      return
    }

    messagePort.postMessage(data)
  })

  self.onerror = (event) => {
    // Fatal worker-side error. Abort lifetime so any in-flight invoke rejects;
    // emit the business event for non-invoke listeners.
    const error = toError(event, 'eventa: invoke cancelled, webworker self error')
    ctx.abort(error)
    ctx.emit(workerErrorEvent, { kind: 'fatal', error }, { raw: { error: event } })
  }

  self.onmessage = (event) => {
    try {
      const { type, payload } = parseWorkerPayload<Eventa<any>>(event.data)
      if (!isWorkerEventa(payload)) {
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { event } })
      }
      else {
        ctx.emit(defineInboundEventa(type), { message: payload.body }, { raw: { event } })
      }
    }
    catch (error) {
      console.error('Failed to parse WebWorker message:', error)
      ctx.emit(workerErrorEvent, { kind: 'parse', error: toError(error, 'eventa: webworker message parse error') }, { raw: { event } })
    }
  }

  return {
    context: ctx,
  }
}

export { workerErrorEvent } from '../shared'
export type { AdapterErrorKind, AdapterErrorPayload } from '../shared'
