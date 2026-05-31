import { describe, expect, it } from 'vitest'

import { toError } from './errors'

// ErrorEvent only exists in browser-like environments, so the instanceof
// branch of toError is exercised here rather than in the node project.
describe('adapters/errors (browser)', () => {
  describe('toError with ErrorEvent', () => {
    it('unwraps the thrown Error from an ErrorEvent', () => {
      const thrown = new RangeError('inner')
      const event = new ErrorEvent('error', { error: thrown, message: 'outer' })
      expect(toError(event, 'fallback')).toBe(thrown)
    })

    it('falls back to the ErrorEvent message when it carries no Error', () => {
      const event = new ErrorEvent('error', { message: 'just a message' })
      expect(toError(event, 'fallback').message).toBe('just a message')
    })

    it('uses the fallback when the ErrorEvent has neither error nor message', () => {
      const event = new ErrorEvent('error')
      expect(toError(event, 'fallback').message).toBe('fallback')
    })
  })
})
