import type { Eventa, EventTag } from './eventa'

import { defineEventa, nanoid } from './eventa'

export enum InvokeEventType {
  SendEvent,
  SendEventError,
  SendEventStreamEnd,
  SendEventAbort,
  ReceiveEvent,
  ReceiveEventError,
  ReceiveEventStreamEnd,
}

export interface SendEvent<Res, Req = undefined, _ = undefined, __ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: Req, isReqStream?: boolean }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEvent
}

export interface SendEventError<Res, Req = undefined, _ = undefined, ReqErr = Error, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: ReqErr }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventError
}

export interface SendEventStreamEnd<Res, Req = undefined, _ = undefined, __ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: undefined }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventStreamEnd
}

export interface SendEventAbort<Res, Req = undefined, _ = undefined, __ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content?: unknown }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventAbort
}

export interface ReceiveEvent<Res, Req = undefined, _ = undefined, __ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: Res }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEvent
}

export interface ReceiveEventError<Res, Req = undefined, ResErr = undefined, _ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: { error: ResErr } }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEventError
}

export interface ReceiveEventStreamEnd<Res, Req = undefined, _ = undefined, __ = undefined, M = undefined, IM = undefined> extends Eventa<{ invokeId: string, content: undefined }, M, IM> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEventStreamEnd
}

export interface InvokeEventa<Res, Req = undefined, ResErr = Error, ReqErr = Error, M = undefined, IM = undefined> {
  sendEvent: SendEvent<Res, Req, ResErr, ReqErr, M, IM>
  sendEventError: SendEventError<Res, Req, ResErr, ReqErr, M, IM>
  sendEventStreamEnd: SendEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>
  sendEventAbort: SendEventAbort<Res, Req, ResErr, ReqErr, M, IM>
  receiveEvent: ReceiveEvent<Res, Req, ResErr, ReqErr, M, IM>
  receiveEventError: ReceiveEventError<Res, Req, ResErr, ReqErr, M, IM>
  receiveEventStreamEnd: ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>
}

export interface InvokeHandlerEventa<Res, Req = undefined, ResErr = Error, ReqErr = Error, M = undefined, _IM = undefined> extends InvokeEventa<Res, Req, ResErr, ReqErr, M, undefined> {
  sendEvent: SendEvent<Res, Req, ResErr, ReqErr, M, undefined>
  sendEventError: SendEventError<Res, Req, ResErr, ReqErr, M, undefined>
  sendEventStreamEnd: SendEventStreamEnd<Res, Req, ResErr, ReqErr, M, undefined>
  sendEventAbort: SendEventAbort<Res, Req, ResErr, ReqErr, M, undefined>
  receiveEvent: ReceiveEvent<Res, Req, ResErr, ReqErr, M, undefined>
  receiveEventError: ReceiveEventError<Res, Req, ResErr, ReqErr, M, undefined>
  receiveEventStreamEnd: ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr, M, undefined>
}

export type InferSendEvent<T> = T extends { sendEvent: SendEvent<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? SendEvent<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferSendEventError<T> = T extends { sendEventError: SendEventError<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? SendEventError<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferSendEventStreamEnd<T> = T extends { sendEventStreamEnd: SendEventStreamEnd<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? SendEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferSendEventAbort<T> = T extends { sendEventAbort: SendEventAbort<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? SendEventAbort<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferReceiveEvent<T> = T extends { receiveEvent: ReceiveEvent<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? ReceiveEvent<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferReceiveEventError<T> = T extends { receiveEventError: ReceiveEventError<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? ReceiveEventError<Res, Req, ResErr, ReqErr, M, IM>
  : never

export type InferReceiveEventStreamEnd<T> = T extends { receiveEventStreamEnd: ReceiveEventStreamEnd<infer Res, infer Req, infer ResErr, infer ReqErr, infer M, infer IM> }
  ? ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>
  : never

export function defineInvokeEventa<Res, Req = undefined, ResErr = Error, ReqErr = Error, M = undefined, IM = undefined>(tag?: string, options?: { metadata?: M, invokeMetadata?: IM }) {
  if (!tag) {
    tag = nanoid()
  }

  const sendEvent = {
    ...defineEventa<InvokeEventType.SendEvent, M, IM>(`${tag}-send`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.SendEvent,
  } as SendEvent<Res, Req, ResErr, ReqErr, M, IM>
  const sendEventError = {
    ...defineEventa<InvokeEventType.SendEventError, M, IM>(`${tag}-send-error`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.SendEventError,
  } as SendEventError<Res, Req, ResErr, ReqErr, M, IM>
  const sendEventStreamEnd = {
    ...defineEventa<InvokeEventType.SendEventStreamEnd, M, IM>(`${tag}-send-stream-end`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.SendEventStreamEnd,
  } as SendEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>
  const sendEventAbort = {
    ...defineEventa<InvokeEventType.SendEventAbort, M, IM>(`${tag}-send-abort`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.SendEventAbort,
  } as SendEventAbort<Res, Req, ResErr, ReqErr, M, IM>
  const receiveEvent = {
    ...defineEventa<InvokeEventType.ReceiveEvent, M, IM>(`${tag}-receive`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.ReceiveEvent,
  } as ReceiveEvent<Res, Req, ResErr, ReqErr, M, IM>
  const receiveEventError = {
    ...defineEventa<InvokeEventType.ReceiveEventError, M, IM>(`${tag}-receive-error`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.ReceiveEventError,
  } as ReceiveEventError<Res, Req, ResErr, ReqErr, M, IM>
  const receiveEventStreamEnd = {
    ...defineEventa<InvokeEventType.ReceiveEventStreamEnd, M, IM>(`${tag}-receive-stream-end`, { metadata: options?.metadata, invokeMetadata: options?.invokeMetadata }),
    invokeType: InvokeEventType.ReceiveEventStreamEnd,
  } as ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr, M, IM>

  return {
    sendEvent,
    sendEventError,
    sendEventStreamEnd,
    sendEventAbort,
    receiveEvent,
    receiveEventError,
    receiveEventStreamEnd,
  } satisfies InvokeEventa<Res, Req, ResErr, ReqErr, M, IM>
}

export function isInvokeEventa(event: Eventa<any>): event is
  | SendEvent<any, any, any, any, any, any>
  | SendEventError<any, any, any, any, any, any>
  | SendEventStreamEnd<any, any, any, any, any, any>
  | ReceiveEvent<any, any, any, any, any, any>
  | ReceiveEventError<any, any, any, any, any, any>
  | ReceiveEventStreamEnd<any, any, any, any, any, any>
  | SendEventAbort<any, any, any, any, any, any> {
  if (typeof event !== 'object') {
    return false
  }
  if ('invokeType' in event) {
    return true
  }

  return false
}

export function isSendEvent(event: Eventa<any>): event is
  | SendEvent<any, any, any, any, any, any>
  | SendEventError<any, any, any, any, any, any>
  | SendEventStreamEnd<any, any, any, any, any, any>
  | SendEventAbort<any, any, any, any, any, any> {
  if (!isInvokeEventa(event)) {
    return false
  }

  return event.invokeType === InvokeEventType.SendEvent
    || event.invokeType === InvokeEventType.SendEventError
    || event.invokeType === InvokeEventType.SendEventStreamEnd
    || event.invokeType === InvokeEventType.SendEventAbort
}

export function isReceiveEvent(event: Eventa<any>): event is
  | ReceiveEvent<any, any, any, any, any, any>
  | ReceiveEventError<any, any, any, any, any, any>
  | ReceiveEventStreamEnd<any, any, any, any, any, any> {
  if (!isInvokeEventa(event)) {
    return false
  }

  return event.invokeType === InvokeEventType.ReceiveEvent
    || event.invokeType === InvokeEventType.ReceiveEventError
    || event.invokeType === InvokeEventType.ReceiveEventStreamEnd
}
