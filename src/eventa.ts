import isGlobMatch from 'picomatch'

import { customAlphabet } from 'nanoid'

export function nanoid() {
  return customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 16)()
}

export interface InvokeEventConstraint<_Req, _Res> {}

export type EventTag<Res, Req> = string & InvokeEventConstraint<Req, Res>

export enum EventaType {
  Event = 'event',
  MatchExpression = 'matchExpression',
}

export enum EventaFlowDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
}

export interface DirectionalEventa<P, T = undefined> extends Eventa<P> {
  _flowDirection: EventaFlowDirection | T
}

export interface InboundEventa<T> extends DirectionalEventa<T> {
  _flowDirection: EventaFlowDirection.Inbound
}

export interface OutboundEventa<T> extends DirectionalEventa<T> {
  _flowDirection: EventaFlowDirection.Outbound
}

export function defineInboundEventa<T>(id?: string): InboundEventa<T> {
  return {
    ...defineEventa<T>(id),
    _flowDirection: EventaFlowDirection.Inbound,
  } as InboundEventa<T>
}

export function defineOutboundEventa<T>(id?: string): OutboundEventa<T> {
  return {
    ...defineEventa<T>(id),
    _flowDirection: EventaFlowDirection.Outbound,
  } as OutboundEventa<T>
}

// type ServerInvokeHandlerEvent<Req, Res> = symbol & InvokeEventConstraint<Req, Res>
// type ClientInvoke<Req> = symbol & InvokeEventConstraint<Req, null>

export interface EventaLike<_P = undefined, T extends EventaType = EventaType> {
  id: string
  type?: T
}

export interface Eventa<P = unknown> extends EventaLike<P, EventaType.Event> {
  body?: P
}

export type InferEventaPayload<E> = E extends Eventa<infer P> ? P : never

export function defineEventa<P = undefined>(id?: string): Eventa<P> {
  if (!id) {
    id = nanoid()
  }

  return {
    id,
    type: EventaType.Event,
  }
}

export interface EventaMatchExpression<P = undefined> extends EventaLike<P, EventaType.MatchExpression> {
  matcher?: (event: Eventa<P>) => boolean | Promise<boolean>
}

export function and<P>(...matchExpression: Array<EventaMatchExpression<P>>): EventaMatchExpression<P> {
  return {
    id: nanoid(),
    type: EventaType.MatchExpression,
    matcher: (event: Eventa<P>) => {
      return matchExpression.every(m => m.matcher ? m.matcher(event) : false)
    },
  }
}

export function or<P>(...matchExpression: Array<EventaMatchExpression<P>>): EventaMatchExpression<P> {
  return {
    id: nanoid(),
    type: EventaType.MatchExpression,
    matcher: (event: Eventa<P>) => {
      return matchExpression.some(m => m.matcher ? m.matcher(event) : false)
    },
  }
}

export function matchBy<P = undefined>(glob: string, inverted?: boolean): EventaMatchExpression<P>
export function matchBy<P = undefined>(options: { ids: string[] }, inverted?: boolean): EventaMatchExpression<P>
export function matchBy<P = undefined>(options: { eventa: Eventa<P>[] }, inverted?: boolean): EventaMatchExpression<P>
export function matchBy<P = undefined>(options: { types: EventaType[] }, inverted?: boolean): EventaMatchExpression<P>
export function matchBy<P = undefined>(regExp: RegExp, inverted?: boolean): EventaMatchExpression<P>
export function matchBy<P = undefined, E extends Eventa<P> = Eventa<P>>(matcher: (event: E) => boolean | Promise<boolean>): EventaMatchExpression<P>
export function matchBy<P = undefined, E extends Eventa<P> = Eventa<P>>(
  matchExpressionPossibleValues:
    | string
    | Eventa<any>
    | { ids: string[] }
    | { eventa: Eventa<P>[] }
    | { types: EventaType[] }
    | RegExp
    | ((event: E) => boolean | Promise<boolean>),
  inverted?: boolean,
): EventaMatchExpression<P> {
  const id = nanoid()

  let matcher: (event: E) => boolean | Promise<boolean> = () => false
  if (typeof matchExpressionPossibleValues === 'string') {
    matcher = (eventa) => {
      return isGlobMatch(matchExpressionPossibleValues)(eventa.id)
    }
  }
  else if (typeof matchExpressionPossibleValues === 'object') {
    if ('ids' in matchExpressionPossibleValues) {
      matcher = (event: Eventa<P>) => {
        if (inverted) {
          return !matchExpressionPossibleValues.ids.includes(event.id)
        }

        return matchExpressionPossibleValues.ids.includes(event.id)
      }
    }
    else if ('eventa' in matchExpressionPossibleValues) {
      matcher = (event: Eventa<P>) => {
        if (inverted) {
          return !matchExpressionPossibleValues.eventa.some(e => e.id === event.id)
        }

        return matchExpressionPossibleValues.eventa.some(e => e.id === event.id)
      }
    }
    else if ('types' in matchExpressionPossibleValues) {
      matcher = (event: Eventa<P>) => {
        if (typeof event.type === 'undefined') {
          return false
        }
        if (inverted) {
          return !matchExpressionPossibleValues.types.includes(event.type)
        }

        return matchExpressionPossibleValues.types.includes(event.type)
      }
    }
  }
  else if (matchExpressionPossibleValues instanceof RegExp) {
    matcher = (event: Eventa<P>) => {
      if (inverted) {
        return !matchExpressionPossibleValues.test(event.id)
      }

      return matchExpressionPossibleValues.test(event.id)
    }
  }
  else if (typeof matchExpressionPossibleValues === 'function') {
    matcher = matchExpressionPossibleValues
  }

  return {
    id,
    type: EventaType.MatchExpression,
    matcher,
  } satisfies EventaMatchExpression<P>
}
