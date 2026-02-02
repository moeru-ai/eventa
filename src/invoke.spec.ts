import type { InvokeFunction } from './invoke'

import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { createContext } from './context'
import { defineInvoke, defineInvokeHandler, defineInvokeHandlers, defineInvokes, undefineInvokeHandler } from './invoke'
import { defineInvokeEventa } from './invoke-shared'

describe('invoke', () => {
  it('should handle request-response pattern', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<{ id: string }, { name: string, age: number }>()

    defineInvokeHandler(ctx, events, ({ name, age }) => ({
      id: `${name}-${age}`,
    }))

    const invoke = defineInvoke(ctx, events)

    const result = await invoke({ name: 'alice', age: 25 })
    expect(result).toEqual({ id: 'alice-25' })
  })

  it('should handle request-response pattern with error', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<{ id: string }, { name: string, age: number }>()

    defineInvokeHandler(ctx, events, ({ name, age }) => {
      throw new Error(`Error processing request for ${name} aged ${age}`)
    })

    const invoke = defineInvoke(ctx, events)

    await expect(invoke({ name: 'alice', age: 25 })).rejects.toThrowError('Error processing request for alice aged 25')
  })

  it('should reject with the same error emitted in receiveEventError payload', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()
    const emittedError = new Error('invoke handler failed')

    defineInvokeHandler(ctx, events, () => {
      throw emittedError
    })

    const invoke = defineInvoke(ctx, events)

    await expect(invoke()).rejects.toBe(emittedError)
  })

  it('should handle multiple concurrent invokes', async () => {
    const ctx = createContext()

    const events = defineInvokeEventa<{ result: number }, { value: number }>()
    defineInvokeHandler(ctx, events, ({ value }) => ({ result: value * 2 }))
    const invoke = defineInvoke(ctx, events)

    const promise1 = invoke({ value: 10 })
    const promise2 = invoke({ value: 20 })
    const promise3 = invoke({ value: 50 })

    const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3])
    expect(result1).toEqual({ result: 20 })
    expect(result2).toEqual({ result: 40 })
    expect(result3).toEqual({ result: 100 })
  })

  it('should register the same handler only once', () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()

    const handler = vi.fn()

    defineInvokeHandler(ctx, events, handler)
    defineInvokeHandler(ctx, events, handler)

    const invoke = defineInvoke(ctx, events)

    invoke()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('should remove specific invoke handler via off', () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()

    const handler = vi.fn()
    const weakHandler = vi.fn()

    defineInvokeHandler(ctx, events, handler)
    const weakOff = defineInvokeHandler(ctx, events, weakHandler)

    const invoke = defineInvoke(ctx, events)

    invoke()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)

    weakOff()
    invoke()
    expect(handler).toHaveBeenCalledTimes(2)
    expect(weakHandler).toHaveBeenCalledTimes(1)
  })

  it('should remove invoke specific handler via undefineInvokeHandler', () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()

    const handler = vi.fn()
    const weakHandler = vi.fn()

    defineInvokeHandler(ctx, events, handler)
    defineInvokeHandler(ctx, events, weakHandler)

    const invoke = defineInvoke(ctx, events)

    invoke()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)

    undefineInvokeHandler(ctx, events, weakHandler)
    invoke()
    expect(handler).toHaveBeenCalledTimes(2)
    expect(weakHandler).toHaveBeenCalledTimes(1)
  })

  it('should remove invoke handlers via undefineInvokeHandler', () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()

    const handler = vi.fn()
    const weakHandler = vi.fn()

    defineInvokeHandler(ctx, events, handler)
    defineInvokeHandler(ctx, events, weakHandler)

    const invoke = defineInvoke(ctx, events)

    invoke()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)

    undefineInvokeHandler(ctx, events)
    invoke()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(weakHandler).toHaveBeenCalledTimes(1)
  })

  it('should define invoke handlers in batch', async () => {
    const ctx = createContext()

    const events = {
      double: defineInvokeEventa<number, number>(),
      append: defineInvokeEventa<string, string>(),
    }

    defineInvokeHandlers(ctx, events, {
      double: input => input * 2,
      append: input => `${input}!`,
    })

    const {
      double: invokeDouble,
      append: invokeAppend,
    } = defineInvokes(ctx, events)

    expect(await invokeDouble(5)).toEqual(10)
    expect(await invokeAppend('test')).toEqual('test!')
  })

  it('should support stream input', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>()

    defineInvokeHandler(ctx, events, async (payload) => {
      const values: number[] = []

      for await (const value of payload) {
        values.push(value)
      }

      return values.reduce((sum, value) => sum + value, 0)
    })

    const invoke = defineInvoke(ctx, events)
    const input = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)

        controller.close()
      },
    })

    const result = await invoke(input)
    expect(result).toBe(6)
  })
})

describe('invoke-type-safety', () => {
  it('should maintain type constraints', () => {
    interface UserRequest {
      name: string
      email: string
    }

    interface UserResponse {
      id: string
      created: boolean
    }

    const events = defineInvokeEventa<UserResponse, UserRequest>()
    const serverCtx = createContext()
    const clientCtx = createContext()

    defineInvokeHandler(serverCtx, events, (req: UserRequest): UserResponse => ({
      id: `user-${req.name}`,
      created: true,
    }))

    const invoke = defineInvoke(clientCtx, events)

    expect(typeof invoke).toBe('function')
  })

  it('should return functions with correct types from defineInvoke when Req is a union type', () => {
    interface A { readonly __brand: unique symbol }
    interface B { readonly __brand: unique symbol }
    interface C { readonly __brand: unique symbol }

    const context = createContext()
    const invokeEventa = defineInvokeEventa<C, A | B>()
    const _invoke = defineInvoke(context, invokeEventa)

    type Expected = InvokeFunction<C, A | B, typeof context>
    expectTypeOf<typeof _invoke>().toEqualTypeOf<Expected>()
  })

  it('should return functions with correct types from defineInvoke when Res is a union type', () => {
    interface A { readonly __brand: unique symbol }
    interface B { readonly __brand: unique symbol }
    interface C { readonly __brand: unique symbol }

    const context = createContext()
    const invokeEventa = defineInvokeEventa<A | B, C>()
    const _invoke = defineInvoke(context, invokeEventa)

    type Expected = InvokeFunction<A | B, C, typeof context>
    expectTypeOf<typeof _invoke>().toEqualTypeOf<Expected>()
  })

  it('should keep stream input when Req is a ReadableStream', () => {
    const context = createContext()
    const invokeEventa = defineInvokeEventa<number, ReadableStream<number>>()
    const _invoke = defineInvoke(context, invokeEventa)

    type Expected = InvokeFunction<number, ReadableStream<number>, typeof context>
    expectTypeOf<typeof _invoke>().toEqualTypeOf<Expected>()
  })
})
