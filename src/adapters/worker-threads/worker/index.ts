import type { MessagePort, Transferable } from 'node:worker_threads'

import type { EventContext } from '../../../context'
import type { DirectionalEventa, Eventa } from '../../../eventa'

import { parentPort } from 'node:worker_threads'

import { createContext as createBaseContext } from '../../../context'
import { registerInvokeAbortEventListeners } from '../../../context-extension-invoke-internal'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../../eventa'
import { generateWorkerPayload, parseWorkerPayload } from '../../webworkers/internal'
import { isWorkerEventa, normalizeOnListenerParameters, workerErrorEvent } from '../../webworkers/shared'

export function createContext(options?: {
  messagePort?: MessagePort
}) {
  const messagePort = options?.messagePort ?? parentPort
  if (!messagePort) {
    throw new Error('Node worker context requires a MessagePort (parentPort is null).')
  }

  const ctx = createBaseContext() as EventContext<
    {
      invokeRequest?: { transfer?: Transferable[] }
      invokeResponse?: { transfer?: Transferable[] }
    },
    { raw: { message?: unknown, error?: unknown, messageError?: unknown }, transfer?: Transferable[] }
  >
  // Configure invoke to fail fast on fatal worker errors (load/syntax/runtime).
  registerInvokeAbortEventListeners(ctx, workerErrorEvent)

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event, options) => {
    const { body, transfer } = normalizeOnListenerParameters(event, options)
    const data = generateWorkerPayload(event.id, { ...defineOutboundEventa(event.type), ...event, body })
    if (transfer != null) {
      messagePort.postMessage(data, transfer as unknown as Transferable[])
      return
    }

    messagePort.postMessage(data)
  })

  messagePort.on('message', (message) => {
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
      ctx.emit(workerErrorEvent, { error }, { raw: { message } })
    }
  })

  messagePort.on('error', (error) => {
    ctx.emit(workerErrorEvent, { error }, { raw: { error } })
  })

  messagePort.on('messageerror', (error) => {
    ctx.emit(workerErrorEvent, { error }, { raw: { messageError: error } })
  })

  return {
    context: ctx,
  }
}
