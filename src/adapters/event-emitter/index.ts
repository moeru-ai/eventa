import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { generatePayload, parsePayload } from './internal'
import { errorEvent } from './shared'

function withRemoval(eventTarget: NodeJS.EventEmitter, type: string, listener: Parameters<NodeJS.EventEmitter['on']>[1]) {
  eventTarget.on(type, listener)

  return {
    remove: () => {
      eventTarget.off(type, listener)
    },
  }
}

export function createContext(eventTarget: NodeJS.EventEmitter, options?: {
  messageEventName?: string | false
  errorEventName?: string | false
  extraListeners?: Record<string, (event: Event) => void | Promise<void>>
}) {
  const ctx = createBaseContext() as EventContext<any, { raw: { event: CustomEvent | Event | unknown } }>

  const {
    messageEventName = 'message',
    errorEventName = 'error',
    extraListeners = {},
  } = options || {}

  const cleanupRemoval: Array<{ remove: () => void }> = []

  ctx.on(and(
    matchBy((e: DirectionalEventa<any>) => e._flowDirection === EventaFlowDirection.Outbound || !e._flowDirection),
    matchBy('*'),
  ), (event) => {
    const detail = generatePayload(event.id, { ...defineOutboundEventa(event.type), ...event })
    eventTarget.emit(event.id, detail)
  })

  if (messageEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, messageEventName, (event) => {
      try {
        const { type, payload } = parsePayload<Eventa<any>>((event as CustomEvent).detail)
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { event } })
      }
      catch (error) {
        console.error('Failed to parse EventEmitter message:', error)
        ctx.emit(errorEvent, { error }, { raw: { event } })
      }
    }))
  }

  if (errorEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, errorEventName, (error) => {
      ctx.emit(errorEvent, { error }, { raw: { event: error } })
    }))
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    cleanupRemoval.push(withRemoval(eventTarget, eventName, listener))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, EventEmitter adapter disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export type * from './shared'
