import { describe, expect, it } from 'vitest'

import { isAsyncIterable, isReadableStream } from './utils'

describe('utils', () => {
  describe('isAsyncIterable', () => {
    it('returns true for async iterables', () => {
      async function* generator() {
        yield 1
      }

      expect(isAsyncIterable(generator())).toBe(true)
    })

    it('returns false for non-async-iterables', () => {
      expect(isAsyncIterable(null)).toBe(false)
      expect(isAsyncIterable(undefined)).toBe(false)
      expect(isAsyncIterable(123)).toBe(false)
      expect(isAsyncIterable('value')).toBe(false)
      expect(isAsyncIterable([1, 2, 3])).toBe(false)
      expect(isAsyncIterable({})).toBe(false)
    })

    it('returns true when Symbol.asyncIterator exists on an object', () => {
      const value = { [Symbol.asyncIterator]: 123 } as const
      expect(isAsyncIterable(value)).toBe(true)
    })
  })

  describe('isReadableStream', () => {
    it('returns true for ReadableStream instances', () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      expect(isReadableStream(stream)).toBe(true)
    })

    it('returns true for objects with a getReader function', () => {
      const value = { getReader: () => ({}) }
      expect(isReadableStream(value)).toBe(true)
    })

    it('returns false for non-stream values', () => {
      expect(isReadableStream(null)).toBe(false)
      expect(isReadableStream(undefined)).toBe(false)
      expect(isReadableStream(123)).toBe(false)
      expect(isReadableStream('stream')).toBe(false)
      expect(isReadableStream({})).toBe(false)
      expect(isReadableStream({ getReader: 123 })).toBe(false)
    })
  })
})
