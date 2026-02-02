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

export interface SendEvent<Res, Req = undefined, _ = undefined, __ = undefined> extends Eventa<{ invokeId: string, content: Req, isReqStream?: boolean }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEvent
}
export interface SendEventError<Res, Req = undefined, _ = undefined, ReqErr = Error> extends Eventa<{ invokeId: string, content: ReqErr }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventError
}
export interface SendEventStreamEnd<Res, Req = undefined, _ = undefined, __ = undefined> extends Eventa<{ invokeId: string, content: undefined }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventStreamEnd
}
export interface SendEventAbort<Res, Req = undefined, _ = undefined, __ = undefined> extends Eventa<{ invokeId: string, content?: unknown }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.SendEventAbort
}
export interface ReceiveEvent<Res, Req = undefined, _ = undefined, __ = undefined> extends Eventa<{ invokeId: string, content: Res }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEvent
}
export interface ReceiveEventError<Res, Req = undefined, ResErr = undefined, _ = undefined> extends Eventa<{ invokeId: string, content: { error: ResErr } }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEventError
}
export interface ReceiveEventStreamEnd<Res, Req = undefined, _ = undefined, __ = undefined> extends Eventa<{ invokeId: string, content: undefined }> {
  id: EventTag<Res, Req>
  invokeType: InvokeEventType.ReceiveEventStreamEnd
}

export interface InvokeEventa<Res, Req = undefined, ResErr = Error, ReqErr = Error> {
  sendEvent: SendEvent<Res, Req, ResErr, ReqErr>
  sendEventError: SendEventError<Res, Req, ResErr, ReqErr>
  sendEventStreamEnd: SendEventStreamEnd<Res, Req, ResErr, ReqErr>
  sendEventAbort: SendEventAbort<Res, Req, ResErr, ReqErr>
  receiveEvent: ReceiveEvent<Res, Req, ResErr, ReqErr>
  receiveEventError: ReceiveEventError<Res, Req, ResErr, ReqErr>
  receiveEventStreamEnd: ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr>
}

export type InferSendEvent<T> = T extends { sendEvent: SendEvent<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? SendEvent<Res, Req, ResErr, ReqErr>
  : never

export type InferSendEventError<T> = T extends { sendEventError: SendEventError<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? SendEventError<Res, Req, ResErr, ReqErr>
  : never

export type InferSendEventStreamEnd<T> = T extends { sendEventStreamEnd: SendEventStreamEnd<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? SendEventStreamEnd<Res, Req, ResErr, ReqErr>
  : never

export type InferSendEventAbort<T> = T extends { sendEventAbort: SendEventAbort<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? SendEventAbort<Res, Req, ResErr, ReqErr>
  : never

export type InferReceiveEvent<T> = T extends { receiveEvent: ReceiveEvent<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? ReceiveEvent<Res, Req, ResErr, ReqErr>
  : never

export type InferReceiveEventError<T> = T extends { receiveEventError: ReceiveEventError<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? ReceiveEventError<Res, Req, ResErr, ReqErr>
  : never

export type InferReceiveEventStreamEnd<T> = T extends { receiveEventStreamEnd: ReceiveEventStreamEnd<infer Res, infer Req, infer ResErr, infer ReqErr> }
  ? ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr>
  : never

export function defineInvokeEventa<Res, Req = undefined, ResErr = Error, ReqErr = Error>(tag?: string) {
  if (!tag) {
    tag = nanoid()
  }

  const sendEvent = {
    ...defineEventa<InvokeEventType.SendEvent>(`${tag}-send`),
    invokeType: InvokeEventType.SendEvent,
  } as SendEvent<Res, Req, ResErr, ReqErr>
  const sendEventError = {
    ...defineEventa<InvokeEventType.SendEventError>(`${tag}-send-error`),
    invokeType: InvokeEventType.SendEventError,
  } as SendEventError<Res, Req, ResErr, ReqErr>
  const sendEventStreamEnd = {
    ...defineEventa<InvokeEventType.SendEventStreamEnd>(`${tag}-send-stream-end`),
    invokeType: InvokeEventType.SendEventStreamEnd,
  } as SendEventStreamEnd<Res, Req, ResErr, ReqErr>
  const sendEventAbort = {
    ...defineEventa<InvokeEventType.SendEventAbort>(`${tag}-send-abort`),
    invokeType: InvokeEventType.SendEventAbort,
  } as SendEventAbort<Res, Req, ResErr, ReqErr>
  const receiveEvent = {
    ...defineEventa<InvokeEventType.ReceiveEvent>(`${tag}-receive`),
    invokeType: InvokeEventType.ReceiveEvent,
  } as ReceiveEvent<Res, Req, ResErr, ReqErr>
  const receiveEventError = {
    ...defineEventa<InvokeEventType.ReceiveEventError>(`${tag}-receive-error`),
    invokeType: InvokeEventType.ReceiveEventError,
  } as ReceiveEventError<Res, Req, ResErr, ReqErr>
  const receiveEventStreamEnd = {
    ...defineEventa<InvokeEventType.ReceiveEventStreamEnd>(`${tag}-receive-stream-end`),
    invokeType: InvokeEventType.ReceiveEventStreamEnd,
  } as ReceiveEventStreamEnd<Res, Req, ResErr, ReqErr>

  return {
    sendEvent,
    sendEventError,
    sendEventStreamEnd,
    sendEventAbort,
    receiveEvent,
    receiveEventError,
    receiveEventStreamEnd,
  } satisfies InvokeEventa<Res, Req, ResErr, ReqErr>
}

export function isInvokeEventa(event: Eventa<any>): event is
  | SendEvent<any, any, any, any>
  | SendEventError<any, any, any, any>
  | SendEventStreamEnd<any, any, any, any>
  | ReceiveEvent<any, any, any, any>
  | ReceiveEventError<any, any, any, any>
  | ReceiveEventStreamEnd<any, any, any, any>
  | SendEventAbort<any, any, any, any> {
  if (typeof event !== 'object') {
    return false
  }
  if ('invokeType' in event) {
    return true
  }

  return false
}

export function isSendEvent(event: Eventa<any>): event is
  | SendEvent<any, any, any, any>
  | SendEventError<any, any, any, any>
  | SendEventStreamEnd<any, any, any, any>
  | SendEventAbort<any, any, any, any> {
  if (!isInvokeEventa(event)) {
    return false
  }

  return event.invokeType === InvokeEventType.SendEvent
    || event.invokeType === InvokeEventType.SendEventError
    || event.invokeType === InvokeEventType.SendEventStreamEnd
    || event.invokeType === InvokeEventType.SendEventAbort
}

export function isReceiveEvent(event: Eventa<any>): event is
  | ReceiveEvent<any, any, any, any>
  | ReceiveEventError<any, any, any, any>
  | ReceiveEventStreamEnd<any, any, any, any> {
  if (!isInvokeEventa(event)) {
    return false
  }

  return event.invokeType === InvokeEventType.ReceiveEvent
    || event.invokeType === InvokeEventType.ReceiveEventError
    || event.invokeType === InvokeEventType.ReceiveEventStreamEnd
}
