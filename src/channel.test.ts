import type { ChannelPipe } from './channel'

import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { defineChannelPlugin, linkChannel, pipeChannel } from './channel'
import { createContext } from './context'
import { defineEventa } from './eventa'
import { defineInvoke, defineInvokeHandler } from './invoke'
import { defineInvokeEventa } from './invoke-shared'

describe('pipeChannel', () => {
  it('routes through each adjacent context in argument order', async () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: string }>('channel:ordered-pipe')
    const traversedEdges: string[] = []
    const receivedBySecond = vi.fn()
    const receivedByThird = vi.fn()

    second.on(event, receivedBySecond)
    third.on(event, receivedByThird)

    const pipe = pipeChannel(first, second, third, {
      plugins: (_event, context) => {
        if (context.source === first && context.target === second) {
          traversedEdges.push('first-to-second')
        }
        if (context.source === second && context.target === third) {
          traversedEdges.push('second-to-third')
        }
      },
    })

    await first.emit(event, { value: 'hello' })

    expect(traversedEdges).toEqual(['first-to-second', 'second-to-third'])
    expect(receivedBySecond).toHaveBeenCalledTimes(1)
    expect(receivedByThird).toHaveBeenCalledTimes(1)

    pipe.dispose()
  })

  it('preserves each edge type in a heterogeneous chain', () => {
    interface FirstExtensions { first: true }
    interface FirstOptions { firstOption: string }
    interface SecondExtensions { second: true }
    interface SecondOptions { secondOption: string }
    interface ThirdExtensions { third: true }
    interface ThirdOptions { thirdOption: string }
    const first = createContext<FirstExtensions, FirstOptions>()
    const second = createContext<SecondExtensions, SecondOptions>()
    const third = createContext<ThirdExtensions, ThirdOptions>()

    const pipe = pipeChannel(first, second, third)

    expectTypeOf(pipe.pipes[0]).toEqualTypeOf<ChannelPipe<FirstExtensions, FirstOptions, SecondExtensions, SecondOptions>>()
    expectTypeOf(pipe.pipes[1]).toEqualTypeOf<ChannelPipe<SecondExtensions, SecondOptions, ThirdExtensions, ThirdOptions>>()
    pipe.dispose()
  })

  it('leaves plugin direction undefined unless configured', () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa('channel:pipe-default-direction')
    const directions: Array<string | undefined> = []
    const pipe = pipeChannel(source, target, (_event, context) => {
      directions.push(context.direction)
    })

    source.emit(event, undefined)

    expect(directions).toEqual([undefined])
    pipe.dispose()
  })

  it('forwards ordinary events synchronously when handlers and plugins are synchronous', () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ message: string }>('channel:ordinary')
    const handler = vi.fn()

    target.on(event, handler)
    const pipe = pipeChannel(source, target)

    source.emit(event, { message: 'hello' })

    expect(handler).toHaveBeenCalledWith({ ...event, body: { message: 'hello' } }, undefined)
    pipe.dispose()
  })

  it('stops forwarding after disposal without aborting either context', () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ value: string }>('channel:dispose')
    const handler = vi.fn()
    target.on(event, handler)

    const pipe = pipeChannel(source, target)
    pipe.dispose()
    source.emit(event, { value: 'after-dispose' })

    expect(handler).not.toHaveBeenCalled()
    expect(source.signal.aborted).toBe(false)
    expect(target.signal.aborted).toBe(false)
  })

  it('fans out through explicit pipes', () => {
    const source = createContext()
    const firstTarget = createContext()
    const secondTarget = createContext()
    const event = defineEventa<{ value: string }>('channel:explicit-fan-out')
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    firstTarget.on(event, firstHandler)
    secondTarget.on(event, secondHandler)

    const firstPipe = pipeChannel(source, firstTarget)
    const secondPipe = pipeChannel(source, secondTarget)
    source.emit(event, { value: 'shared' })

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler).toHaveBeenCalledTimes(1)
    firstPipe.dispose()
    secondPipe.dispose()
  })

  it('drops an event when an edge plugin returns false', () => {
    const source = createContext()
    const target = createContext()
    const allowed = defineEventa<{ value: string }>('channel:allowed')
    const blocked = defineEventa<{ value: string }>('channel:blocked')
    const handler = vi.fn()
    target.on(allowed, handler)
    target.on(blocked, handler)

    const pipe = pipeChannel(source, target, event => event.id === blocked.id ? false : undefined)
    source.emit(blocked, { value: 'blocked' })
    source.emit(allowed, { value: 'allowed' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].body).toEqual({ value: 'allowed' })
    pipe.dispose()
  })

  it('transforms events through plugins in registration order', () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ value: number }>('channel:transform')
    const handler = vi.fn()
    const deliveryBodies: number[] = []
    target.on(event, handler)

    const pipe = pipeChannel(source, target, [
      current => ({ ...current, body: { value: (current.body as { value: number }).value + 1 } }),
      (current, context) => {
        deliveryBodies.push((context.inner.eventa.body as { value: number }).value)
        return { ...current, body: { value: (current.body as { value: number }).value * 2 } }
      },
    ])
    source.emit(event, { value: 2 })

    expect(handler.mock.calls[0][0].body).toEqual({ value: 6 })
    expect(deliveryBodies).toEqual([3])
    pipe.dispose()
  })

  it('awaits asynchronous plugins before resolving emit', async () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ value: number }>('channel:async-transform')
    const handler = vi.fn()
    target.on(event, handler)

    const pipe = pipeChannel(source, target, async current => ({
      ...current,
      body: { value: (current.body as { value: number }).value + 10 },
    }))

    await source.emit(event, { value: 1 })
    expect(handler.mock.calls[0][0].body).toEqual({ value: 11 })
    pipe.dispose()
  })

  it('preserves one delivery identity while each edge plugin transforms the Eventa', async () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: number }>('channel:delivery-identity')
    const deliveryIds: string[] = []
    const receivedByThird = vi.fn()
    third.on(event, receivedByThird)

    const pipe = pipeChannel(first, second, third, defineChannelPlugin((current, context) => {
      deliveryIds.push(context.inner.deliveryId)
      return { ...current, body: { value: (current.body as { value: number }).value + 1 } }
    }))

    await first.emit(event, { value: 1 })

    expect(new Set(deliveryIds).size).toBe(1)
    expect(deliveryIds).toHaveLength(2)
    expect(receivedByThird.mock.calls[0][0].body).toEqual({ value: 3 })
    pipe.dispose()
  })

  it('keeps a child-pipe plugin scoped to one edge', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: number }>('channel:child-plugin')
    const secondHandler = vi.fn()
    const thirdHandler = vi.fn()
    second.on(event, secondHandler)
    third.on(event, thirdHandler)

    const pipe = pipeChannel(first, second, third)
    pipe.pipes[1].use(current => ({ ...current, body: { value: (current.body as { value: number }).value + 10 } }))
    first.emit(event, { value: 1 })

    expect(secondHandler.mock.calls[0][0].body).toEqual({ value: 1 })
    expect(thirdHandler.mock.calls[0][0].body).toEqual({ value: 11 })
    pipe.dispose()
  })

  it('removes only the plugin registration returned by use', () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ value: number }>('channel:use')
    const handler = vi.fn()
    target.on(event, handler)

    const pipe = pipeChannel(source, target)
    const plugin: Parameters<typeof pipe.use>[0] = current => ({
      ...current,
      body: { value: (current.body as { value: number }).value + 10 },
    })
    const removeFirst = pipe.use(plugin)
    pipe.use(plugin)

    source.emit(event, { value: 1 })
    removeFirst()
    source.emit(event, { value: 1 })

    expect(handler.mock.calls[0][0].body).toEqual({ value: 21 })
    expect(handler.mock.calls[1][0].body).toEqual({ value: 11 })
    pipe.dispose()
  })

  it('dispatches at the last allowed hop without forwarding farther', () => {
    const first = createContext({ routing: { initialHops: 1 } })
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: string }>('channel:hop-budget')
    const secondHandler = vi.fn()
    const thirdHandler = vi.fn()
    second.on(event, secondHandler)
    third.on(event, thirdHandler)

    const pipe = pipeChannel(first, second, third)
    first.emit(event, { value: 'bounded' })

    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(thirdHandler).not.toHaveBeenCalled()
    pipe.dispose()
  })

  it('rejects emit when a synchronous plugin fails', async () => {
    const source = createContext()
    const target = createContext()
    const event = defineEventa<{ value: string }>('channel:plugin-error')
    const failure = new Error('plugin failed')
    const pipe = pipeChannel(source, target, () => {
      throw failure
    })

    await expect(source.emit(event, { value: 'boom' })).rejects.toBe(failure)
    pipe.dispose()
  })
})

describe('linkChannel', () => {
  it('routes bidirectionally between adjacent contexts', () => {
    const left = createContext()
    const right = createContext()
    const ping = defineEventa<{ value: string }>('channel:ping')
    const pong = defineEventa<{ value: string }>('channel:pong')
    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(pong, leftHandler)
    right.on(ping, rightHandler)

    const link = linkChannel(left, right)
    left.emit(ping, { value: 'right' })
    right.emit(pong, { value: 'left' })

    expect(rightHandler).toHaveBeenCalledTimes(1)
    expect(leftHandler).toHaveBeenCalledTimes(1)
    link.dispose()
  })

  it('preserves established directions and each heterogeneous edge type', () => {
    interface FirstExtensions { first: true }
    interface FirstOptions { firstOption: string }
    interface SecondExtensions { second: true }
    interface SecondOptions { secondOption: string }
    interface ThirdExtensions { third: true }
    interface ThirdOptions { thirdOption: string }
    const first = createContext<FirstExtensions, FirstOptions>()
    const second = createContext<SecondExtensions, SecondOptions>()
    const third = createContext<ThirdExtensions, ThirdOptions>()
    const event = defineEventa('channel:link-directions')
    const directions: string[] = []
    const link = linkChannel(first, second, third, {
      plugins: (_event, context) => {
        directions.push(context.direction!)
      },
    })

    expectTypeOf(link.pipes[0]).toEqualTypeOf<ChannelPipe<FirstExtensions, FirstOptions, SecondExtensions, SecondOptions>>()
    expectTypeOf(link.pipes[1]).toEqualTypeOf<ChannelPipe<SecondExtensions, SecondOptions, FirstExtensions, FirstOptions>>()
    expectTypeOf(link.pipes[2]).toEqualTypeOf<ChannelPipe<SecondExtensions, SecondOptions, ThirdExtensions, ThirdOptions>>()
    expectTypeOf(link.pipes[3]).toEqualTypeOf<ChannelPipe<ThirdExtensions, ThirdOptions, SecondExtensions, SecondOptions>>()

    first.emit(event, undefined)
    third.emit(event, undefined)
    expect(directions).toEqual([
      'left-to-right',
      'context-1-to-2',
      'context-2-to-1',
      'right-to-left',
    ])
    link.dispose()
  })

  it('creates only adjacent edges in a variadic chain', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: string }>('channel:ordered-link')
    const edges: string[] = []
    const thirdHandler = vi.fn()
    third.on(event, thirdHandler)

    const link = linkChannel(first, second, third, {
      plugins: (_event, context) => {
        if (context.source === first && context.target === second) {
          edges.push('first-to-second')
        }
        if (context.source === second && context.target === third) {
          edges.push('second-to-third')
        }
        if (context.source === first && context.target === third) {
          edges.push('first-to-third')
        }
      },
    })
    first.emit(event, { value: 'hello' })

    expect(edges).toEqual(['first-to-second', 'second-to-third'])
    expect(link.pipes).toHaveLength(4)
    expect(thirdHandler).toHaveBeenCalledTimes(1)
    link.dispose()
  })

  it('applies a group plugin once on every adjacent edge and removes it', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: number }>('channel:link-use')
    const handler = vi.fn()
    third.on(event, handler)

    const link = linkChannel(first, second, third)
    const remove = link.use(current => ({
      ...current,
      body: { value: (current.body as { value: number }).value + 1 },
    }))

    first.emit(event, { value: 1 })
    remove()
    first.emit(event, { value: 1 })

    expect(handler.mock.calls[0][0].body).toEqual({ value: 3 })
    expect(handler.mock.calls[1][0].body).toEqual({ value: 1 })
    link.dispose()
  })

  it('keeps a child-pipe plugin scoped to one link direction', () => {
    const left = createContext()
    const right = createContext()
    const event = defineEventa<{ value: number }>('channel:link-child-plugin')
    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(event, leftHandler)
    right.on(event, rightHandler)

    const link = linkChannel(left, right)
    link.pipes[0].use(current => ({
      ...current,
      body: { value: (current.body as { value: number }).value + 10 },
    }))

    left.emit(event, { value: 1 })
    right.emit(event, { value: 1 })

    expect(rightHandler.mock.calls[0][0].body).toEqual({ value: 11 })
    expect(rightHandler.mock.calls[1][0].body).toEqual({ value: 1 })
    expect(leftHandler.mock.calls[0][0].body).toEqual({ value: 1 })
    expect(leftHandler.mock.calls[1][0].body).toEqual({ value: 1 })
    link.dispose()
  })

  it('disposes both link directions idempotently without aborting contexts', () => {
    const left = createContext()
    const right = createContext()
    const event = defineEventa<{ value: string }>('channel:link-dispose')
    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(event, leftHandler)
    right.on(event, rightHandler)

    const link = linkChannel(left, right)
    link.dispose()
    link.dispose()
    left.emit(event, { value: 'left' })
    right.emit(event, { value: 'right' })

    expect(leftHandler).toHaveBeenCalledOnce()
    expect(rightHandler).toHaveBeenCalledOnce()
    expect(left.signal.aborted).toBe(false)
    expect(right.signal.aborted).toBe(false)
  })

  it('dispatches a delivery once per context in a cycle', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: string }>('channel:cycle')
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    const thirdHandler = vi.fn()
    first.on(event, firstHandler)
    second.on(event, secondHandler)
    third.on(event, thirdHandler)

    const chain = linkChannel(first, second, third)
    const closingEdge = linkChannel(third, first)
    first.emit(event, { value: 'once' })

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(thirdHandler).toHaveBeenCalledTimes(1)
    chain.dispose()
    closingEdge.dispose()
  })

  it('does not propagate context abort through links', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const link = linkChannel(first, second, third)

    second.abort(new Error('second closed'))

    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(true)
    expect(third.signal.aborted).toBe(false)
    link.dispose()
  })

  it('carries unary invoke through an intermediate context', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<{ output: string }, { input: string }>('channel:invoke')
    const requestDeliveryIds: string[] = []
    const responseDeliveryIds: string[] = []
    const invokeIds: string[] = []
    const link = linkChannel(caller, gateway, handler, {
      plugins: (event, { inner }) => {
        if (event.id === events.sendEvent.id) {
          requestDeliveryIds.push(inner.deliveryId)
          invokeIds.push((event.body as { invokeId: string }).invokeId)
        }
        if (event.id.startsWith(events.receiveEvent.id)) {
          responseDeliveryIds.push(inner.deliveryId)
          invokeIds.push((event.body as { invokeId: string }).invokeId)
        }
      },
    })

    defineInvokeHandler(handler, events, ({ input }) => ({ output: input.toUpperCase() }))
    const invoke = defineInvoke(caller, events)

    await expect(invoke({ input: 'hello' })).resolves.toEqual({ output: 'HELLO' })
    expect(new Set(requestDeliveryIds).size).toBe(1)
    expect(requestDeliveryIds).toHaveLength(2)
    expect(new Set(responseDeliveryIds).size).toBe(1)
    expect(responseDeliveryIds).toHaveLength(2)
    expect(responseDeliveryIds[0]).not.toBe(requestDeliveryIds[0])
    expect(new Set(invokeIds).size).toBe(1)
    link.dispose()
  })

  it('routes invocation cancellation without aborting contexts', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<{ output: string }, { input: string }>('channel:invoke-abort')
    const link = linkChannel(caller, gateway, handler)
    let notifyStarted: () => void
    let notifyCancelled: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      notifyCancelled = resolve
    })

    defineInvokeHandler(handler, events, (_payload, options) => new Promise((resolve) => {
      notifyStarted()
      options?.abortController?.signal.addEventListener('abort', () => {
        notifyCancelled()
        resolve({ output: 'cancelled' })
      }, { once: true })
    }))

    const controller = new AbortController()
    const invoke = defineInvoke(caller, events)
    const pending = invoke({ input: 'hello' }, { signal: controller.signal })
    await started
    controller.abort('cancelled by caller')

    await expect(pending).rejects.toBeInstanceOf(Error)
    await cancelled
    expect(caller.signal.aborted).toBe(false)
    expect(gateway.signal.aborted).toBe(false)
    expect(handler.signal.aborted).toBe(false)
    link.dispose()
  })

  // ROOT CAUSE:
  //
  // An asynchronous request edge can let the cancellation delivery arrive at
  // the handler first. The old abort path synthesized an empty request stream
  // and invoked the handler, then the delayed unary request invoked it again.
  //
  // We retain an abort tombstone until the real request arrives, so one handler
  // invocation receives the matching cancellation signal.
  it('invokes a handler once when cancellation overtakes its request', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<string, string>('channel:invoke-reordered-abort')
    let releaseRequest: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const link = linkChannel(caller, gateway, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          await requestGate
        }
      },
    })
    let notifyCancelled: () => void
    const cancelled = new Promise<void>((resolve) => {
      notifyCancelled = resolve
    })
    let handlerCalls = 0
    defineInvokeHandler(handler, events, (_payload, options) => new Promise((resolve) => {
      handlerCalls += 1
      options?.abortController?.signal.addEventListener('abort', () => {
        notifyCancelled()
        resolve('cancelled')
      }, { once: true })
    }))

    const controller = new AbortController()
    const pending = defineInvoke(caller, events)('hello', { signal: controller.signal })
    controller.abort('cancelled before request arrived')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    releaseRequest!()
    await cancelled

    expect(handlerCalls).toBe(1)
    link.dispose()
  })

  it('errors a request stream when cancellation overtakes its first chunk', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('channel:stream-reordered-abort')
    let notifyRequestBlocked: () => void
    const requestBlocked = new Promise<void>((resolve) => {
      notifyRequestBlocked = resolve
    })
    let releaseRequest: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const link = linkChannel(caller, gateway, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          notifyRequestBlocked()
          await requestGate
        }
      },
    })
    let handlerError: unknown
    let notifyHandlerSettled: () => void
    const handlerSettled = new Promise<void>((resolve) => {
      notifyHandlerSettled = resolve
    })
    let handlerCalls = 0
    defineInvokeHandler(handler, events, async (request) => {
      handlerCalls += 1
      try {
        for await (const _value of request) {
          // Consume until cancellation errors the reconstructed request stream.
        }
      }
      catch (error) {
        handlerError = error
      }
      finally {
        notifyHandlerSettled()
      }
      return 0
    })
    const request = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })

    const controller = new AbortController()
    const pending = defineInvoke(caller, events)(request, { signal: controller.signal })
    await requestBlocked
    controller.abort('cancelled before first chunk arrived')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    releaseRequest!()
    await handlerSettled
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handlerCalls).toBe(1)
    expect(handlerError).toMatchObject({ name: 'AbortError' })
    link.dispose()
  })
})
