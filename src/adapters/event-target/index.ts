import type { EventContext } from '../../context'
import type { DirectionalEventa, Eventa } from '../../eventa'

import { createContext as createBaseContext } from '../../context'
import { and, defineInboundEventa, defineOutboundEventa, EventaFlowDirection, EventaType, matchBy } from '../../eventa'
import { toError } from '../errors'
import { generateCustomEventDetail, parseCustomEventDetail } from './internal'
import { adapterErrorEvent } from './shared'

function withRemoval(eventTarget: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null) {
  eventTarget.addEventListener(type, listener)

  return {
    remove: () => {
      eventTarget.removeEventListener(type, listener)
    },
  }
}

export function createContext(eventTarget: EventTarget, options?: {
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
    const detail = generateCustomEventDetail(event.id, { ...defineOutboundEventa(event.type), ...event })

    const customEvent = new CustomEvent(messageEventName || EventaType.Event, {
      detail,
      bubbles: true,
      cancelable: true,
    })

    eventTarget.dispatchEvent(customEvent)
  })

  if (messageEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, messageEventName, (event) => {
      try {
        const { type, payload } = parseCustomEventDetail<Eventa<any>>((event as CustomEvent).detail)
        ctx.emit(defineInboundEventa(type), payload.body, { raw: { event } })
      }
      catch (error) {
        console.error('Failed to parse EventTarget message:', error)
        ctx.emit(adapterErrorEvent, { kind: 'parse', error: toError(error, 'eventa: EventTarget message parse error') }, { raw: { event } })
      }
    }))
  }

  if (errorEventName) {
    cleanupRemoval.push(withRemoval(eventTarget, errorEventName, (event) => {
      ctx.emit(adapterErrorEvent, { kind: 'fatal', error: toError(event, 'eventa: EventTarget error') }, { raw: { event } })
    }))
  }

  for (const [eventName, listener] of Object.entries(extraListeners)) {
    cleanupRemoval.push(withRemoval(eventTarget, eventName, listener))
  }

  return {
    context: ctx,
    dispose: (reason?: unknown) => {
      ctx.abort(reason ?? new Error('eventa: invoke cancelled, EventTarget adapter disposed'))
      cleanupRemoval.forEach(removal => removal.remove())
    },
  }
}

export { adapterErrorEvent } from './shared'
export type * from './shared'
