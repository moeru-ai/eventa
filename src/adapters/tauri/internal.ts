import type { EventTag } from '../../eventa'
import type { Payload } from './shared'

import { nanoid } from '../../eventa'

interface SerializedError {
  __eventaError: true
  name: string
  message: string
  stack?: string
  cause?: unknown
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isSerializedError(value: unknown): value is SerializedError {
  return typeof value === 'object'
    && value !== null
    && '__eventaError' in value
    && value.__eventaError === true
    && 'name' in value
    && typeof value.name === 'string'
    && 'message' in value
    && typeof value.message === 'string'
    && (!('stack' in value) || typeof value.stack === 'string' || typeof value.stack === 'undefined')
}

function encodeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`eventa: Tauri payload contains a non-JSON value (${typeof value})`)
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('eventa: Tauri payload contains a non-finite number')
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  if (ancestors.has(value)) {
    throw new TypeError('eventa: Tauri payload contains a circular reference')
  }

  ancestors.add(value)
  try {
    if (value instanceof Error) {
      const serialized: SerializedError = {
        __eventaError: true,
        name: value.name || 'Error',
        message: value.message,
      }

      if (value.stack !== undefined) {
        serialized.stack = value.stack
      }
      if (value.cause !== undefined) {
        serialized.cause = encodeValue(value.cause, ancestors)
      }

      return serialized
    }

    if (Array.isArray(value)) {
      return value.map(item => encodeValue(item, ancestors))
    }

    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, encodeValue(child, ancestors)]),
      )
    }

    const toJSON = (value as { toJSON?: () => unknown }).toJSON
    if (typeof toJSON === 'function') {
      return encodeValue(toJSON.call(value), ancestors)
    }

    throw new TypeError(`eventa: Tauri payload contains a non-JSON object (${value.constructor?.name || 'unknown'})`)
  }
  finally {
    ancestors.delete(value)
  }
}

function decodeValue(value: unknown): unknown {
  if (isSerializedError(value)) {
    let error: Error
    switch (value.name) {
      case 'EvalError':
        error = new EvalError(value.message)
        break
      case 'RangeError':
        error = new RangeError(value.message)
        break
      case 'ReferenceError':
        error = new ReferenceError(value.message)
        break
      case 'SyntaxError':
        error = new SyntaxError(value.message)
        break
      case 'TypeError':
        error = new TypeError(value.message)
        break
      case 'URIError':
        error = new URIError(value.message)
        break
      default:
        error = new Error(value.message)
        error.name = value.name
        break
    }
    error.stack = value.stack
    if (value.cause !== undefined) {
      error.cause = decodeValue(value.cause)
    }
    return error
  }

  if (Array.isArray(value)) {
    return value.map(decodeValue)
  }

  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeValue(child)]),
    )
  }

  return value
}

export function generatePayload<T>(type: EventTag<any, any>, payload: T): Payload<T> {
  return {
    id: nanoid(),
    type,
    payload: encodeValue(payload, new WeakSet()) as T,
  }
}

export function parsePayload<T>(data: unknown): Payload<T> {
  const decoded = decodeValue(data)
  if (typeof decoded !== 'object' || decoded === null) {
    throw new TypeError('eventa: invalid Tauri payload')
  }

  if (!('id' in decoded) || typeof decoded.id !== 'string') {
    throw new TypeError('eventa: invalid Tauri payload id')
  }
  if (!('type' in decoded) || typeof decoded.type !== 'string') {
    throw new TypeError('eventa: invalid Tauri payload type')
  }
  if (!('payload' in decoded) || typeof decoded.payload !== 'object' || decoded.payload === null) {
    throw new TypeError('eventa: invalid Tauri event payload')
  }

  return decoded as Payload<T>
}
