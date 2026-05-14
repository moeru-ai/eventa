import { describe, expect, it, vi } from 'vitest'

import { createContext } from './context'
import { defineEventa } from './eventa'
import { defineInvoke } from './invoke'
import { defineInvokeEventa } from './invoke-shared'

describe('eventContext', () => {
  it('should register and emit events', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')
    const handler = vi.fn()

    ctx.on(testEvent, handler)
    ctx.emit(testEvent, { data: 'test' })

    expect(handler).toHaveBeenCalledWith({ ...testEvent, body: { data: 'test' } }, undefined)
  })

  it('should register the same handler only once', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')

    const handler = vi.fn()

    ctx.on(testEvent, handler)
    ctx.on(testEvent, handler)
    ctx.emit(testEvent, { data: 'test' })

    expect(handler).toHaveBeenCalledWith({ ...testEvent, body: { data: 'test' } }, undefined)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('should handle once listeners', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')
    const handler = vi.fn()

    ctx.once(testEvent, handler)
    ctx.emit(testEvent, { data: 'test1' })
    ctx.emit(testEvent, { data: 'test2' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ ...testEvent, body: { data: 'test1' } }, undefined)
  })

  it('should remove listeners with off', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')
    const handler = vi.fn()

    ctx.on(testEvent, handler)
    ctx.off(testEvent)
    ctx.emit(testEvent, { data: 'test' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('should remove listeners with returned off', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')
    const handler = vi.fn()

    const off = ctx.on(testEvent, handler)
    off()
    ctx.emit(testEvent, { data: 'test' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('should remove specific listener with off', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')

    const handler = vi.fn()
    const weakHandler = vi.fn()

    ctx.on(testEvent, handler)
    ctx.on(testEvent, weakHandler)

    ctx.emit(testEvent, { data: 'test' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)

    ctx.off(testEvent, weakHandler)

    ctx.emit(testEvent, { data: 'test' })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(weakHandler).toHaveBeenCalledTimes(1)
  })

  it('should remove specific listener with returned off', () => {
    const ctx = createContext()
    const testEvent = defineEventa('test-event')

    const handler = vi.fn()
    const weakHandler = vi.fn()

    ctx.on(testEvent, handler)
    const weakOff = ctx.on(testEvent, weakHandler)

    ctx.emit(testEvent, { data: 'test' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)

    weakOff()

    ctx.emit(testEvent, { data: 'test' })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(weakHandler).toHaveBeenCalledTimes(1)
  })

  describe('lifetime signal / abort', () => {
    it('exposes an unaborted AbortSignal on a fresh context', () => {
      const ctx = createContext()
      expect(ctx.signal).toBeInstanceOf(AbortSignal)
      expect(ctx.signal.aborted).toBe(false)
    })

    it('aborts the signal with the supplied reason', () => {
      const ctx = createContext()
      const reason = new Error('transport gone')

      ctx.abort(reason)

      expect(ctx.signal.aborted).toBe(true)
      expect(ctx.signal.reason).toBe(reason)
    })

    it('is idempotent — repeated abort() calls do not change the reason', () => {
      const ctx = createContext()
      const first = new Error('first')
      const second = new Error('second')

      ctx.abort(first)
      ctx.abort(second)

      expect(ctx.signal.aborted).toBe(true)
      expect(ctx.signal.reason).toBe(first)
    })

    it('rejects an already-pending invoke when ctx.abort() fires later', async () => {
      // ROOT CAUSE:
      //
      // Before the ctx.signal cascade, defineInvoke had no signal of its own
      // for "transport died" — only per-invoke receive events. Any caller
      // whose transport died with an in-flight invoke would hang forever.
      // This test exercises the cascade end-to-end at the unit level (no
      // adapter, no transport — just ctx + invoke).
      const ctx = createContext()
      const events = defineInvokeEventa<string, string>('test:abort-cascade')
      const invoke = defineInvoke(ctx, events)

      const pending = invoke('hello')
      const reason = new Error('manual abort')
      ctx.abort(reason)

      await expect(pending).rejects.toBe(reason)
    })

    it('rejects synchronously when ctx is already aborted before invoke()', async () => {
      const ctx = createContext()
      const events = defineInvokeEventa<string, string>('test:abort-already')
      const reason = new Error('died before invoke')
      ctx.abort(reason)

      const invoke = defineInvoke(ctx, events)
      await expect(invoke('hello')).rejects.toBe(reason)
    })
  })
})
