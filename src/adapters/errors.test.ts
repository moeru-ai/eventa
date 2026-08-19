import { describe, expect, it } from 'vitest'

import { toError } from './errors'

// ErrorEvent is a browser-only global; the instanceof-ErrorEvent path is
// covered in errors.browser.test.ts. These cases run in the node project and
// exercise the Error, plain-object, and fallback branches.
describe('adapters/errors', () => {
  describe('toError', () => {
    it('returns the same Error instance when given an Error', () => {
      const original = new TypeError('boom')
      expect(toError(original, 'fallback')).toBe(original)
    })

    it('preserves the stack of the original Error', () => {
      const original = new Error('with stack')
      expect(toError(original, 'fallback').stack).toBe(original.stack)
    })

    it('unwraps a thrown Error from an error-event-like object', () => {
      const thrown = new Error('inner')
      expect(toError({ error: thrown }, 'fallback')).toBe(thrown)
    })

    it('uses the message of a plain object that has one', () => {
      expect(toError({ message: 'plain message' }, 'fallback').message).toBe('plain message')
    })

    it('uses the fallback message for a MessageEvent (no error, no message)', () => {
      const event = new MessageEvent('messageerror', { data: { some: 'payload' } })
      expect(toError(event, 'fallback message').message).toBe('fallback message')
    })

    it('uses the fallback message for primitives and empty values', () => {
      expect(toError('a string', 'fallback').message).toBe('fallback')
      expect(toError(undefined, 'fallback').message).toBe('fallback')
      expect(toError(null, 'fallback').message).toBe('fallback')
      expect(toError({ message: '' }, 'fallback').message).toBe('fallback')
    })

    it('always returns an Error instance', () => {
      expect(toError(42, 'fallback')).toBeInstanceOf(Error)
    })
  })
})
