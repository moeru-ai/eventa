import type { ChannelLink, ChannelPipeGroup } from './channel'

import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { defineChannelPlugin, linkChannel, pipeChannel } from './channel'
import { createContext } from './context'
import { defineEventa } from './eventa'
import { defineInvoke, defineInvokeHandler } from './invoke'
import { defineInvokeEventa } from './invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler } from './stream'

describe('pipeChannel', () => {
  it('forwards ordinary events from source to target', () => {
    const from = createContext()
    const to = createContext()

    const event = defineEventa<{ message: string }>('channel:ordinary')

    const handler = vi.fn()
    to.on(event, handler)

    const pipe = pipeChannel(from, to)

    from.emit(event, { message: 'hello' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ id: event.id, body: { message: 'hello' } })

    pipe.dispose()
  })

  it('does not echo inbound events back through a channel connection', () => {
    const from = createContext()
    const to = createContext()
    const event = defineEventa<{ value: number }>('channel:no-echo')

    const fromHandler = vi.fn()
    const toHandler = vi.fn()
    from.on(event, fromHandler)
    to.on(event, toHandler)

    const toRight = pipeChannel(from, to)
    const toLeft = pipeChannel(to, from)

    from.emit(event, { value: 1 })

    expect(fromHandler).toHaveBeenCalledTimes(1)
    expect(toHandler).toHaveBeenCalledTimes(1)

    toRight.dispose()
    toLeft.dispose()
  })

  it('stops forwarding after dispose without aborting either context', () => {
    const from = createContext()
    const to = createContext()

    const event = defineEventa<{ value: string }>('channel:dispose')

    const handler = vi.fn()
    to.on(event, handler)

    const pipe = pipeChannel(from, to)

    pipe.dispose()
    from.emit(event, { value: 'after-dispose' })

    expect(handler).not.toHaveBeenCalled()
    expect(from.signal.aborted).toBe(false)
    expect(to.signal.aborted).toBe(false)
  })

  it('propagates source abort to every target in a fan-out', () => {
    const source = createContext()
    const firstTarget = createContext()
    const secondTarget = createContext()

    const reason = new Error('source transport closed')

    const pipe = pipeChannel(source, firstTarget, secondTarget)

    source.abort(reason)

    expect(firstTarget.signal.aborted).toBe(true)
    expect(firstTarget.signal.reason).toBe(reason)
    expect(secondTarget.signal.aborted).toBe(true)
    expect(secondTarget.signal.reason).toBe(reason)

    pipe.dispose()
  })

  it('stops abort propagation after dispose', () => {
    const source = createContext()
    const target = createContext()

    const reason = new Error('after dispose')

    const pipe = pipeChannel(source, target)

    pipe.dispose()
    source.abort(reason)

    expect(target.signal.aborted).toBe(false)
  })

  it('can disable abort propagation for a pipe', () => {
    const source = createContext()
    const target = createContext()

    const reason = new Error('source transport closed')

    const pipe = pipeChannel(source, target, { propagateAbort: false })

    source.abort(reason)

    expect(target.signal.aborted).toBe(false)

    pipe.dispose()
  })

  it('drops events when a plugin returns false', () => {
    const from = createContext()
    const to = createContext()

    const allowed = defineEventa<{ value: string }>('channel:allowed')
    const blocked = defineEventa<{ value: string }>('channel:blocked')

    const handler = vi.fn()
    const secondPlugin = vi.fn()
    to.on(allowed, handler)
    to.on(blocked, handler)

    pipeChannel(from, to, [
      event => event.id === allowed.id ? undefined : false,
      secondPlugin,
    ])

    from.emit(blocked, { value: 'blocked' })
    from.emit(allowed, { value: 'allowed' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].id).toBe(allowed.id)
    expect(handler.mock.calls[0][0].body).toEqual({ value: 'allowed' })
    expect(secondPlugin).toHaveBeenCalledTimes(1)
  })

  it('transforms events through plugins in registration order', () => {
    const from = createContext()
    const to = createContext()

    const event = defineEventa<{ value: number }>('channel:transform')
    const calls: string[] = []

    const handler = vi.fn()
    to.on(event, handler)

    const pipe = pipeChannel(from, to, [
      // plugin 1
      (current) => {
        calls.push('first')
        return {
          ...current,
          body: { value: current.body!.value + 1 },
          metadata: { step: 'first' },
        }
      },
      // plugin 2
      (current) => {
        calls.push('second')
        return {
          ...current,
          body: { value: current.body!.value * 2 },
          metadata: { ...(current.metadata ?? {}), step: 'second' },
        }
      },
    ])

    from.emit(event, { value: 2 })

    expect(calls).toEqual(['first', 'second'])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].body).toEqual({ value: 6 })
    expect(handler.mock.calls[0][0].metadata).toEqual({ step: 'second' })

    pipe.dispose()
  })

  it('awaits async plugins before forwarding events', async () => {
    const from = createContext()
    const to = createContext()

    const event = defineEventa<{ value: number }>('channel:async-transform')

    const handler = vi.fn()
    to.on(event, handler)

    const pipe = pipeChannel(from, to, async current => ({
      ...current,
      body: { value: current.body!.value + 10 },
    }))

    await from.emit(event, { value: 1 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].body).toEqual({ value: 11 })

    pipe.dispose()
  })

  it('fans out events through multiple ordinary one-way pipes', () => {
    const source = createContext()
    const firstTarget = createContext()
    const secondTarget = createContext()

    const event = defineEventa<{ value: string }>('channel:fan-out')

    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    firstTarget.on(event, firstHandler)
    secondTarget.on(event, secondHandler)

    const pipe = pipeChannel(source, firstTarget, secondTarget)

    source.emit(event, { value: 'shared' })

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(firstHandler.mock.calls[0][0].body).toEqual({ value: 'shared' })
    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler.mock.calls[0][0].body).toEqual({ value: 'shared' })

    pipe.dispose()
  })

  it('applies plugins added with use to every target in a fan-out', () => {
    const source = createContext()
    const firstTarget = createContext()
    const secondTarget = createContext()

    const event = defineEventa<{ value: number }>('channel:fan-out:plugins')

    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    firstTarget.on(event, firstHandler)
    secondTarget.on(event, secondHandler)

    const pipe = pipeChannel(source, firstTarget, secondTarget)

    pipe.use(current => ({
      ...current,
      body: { value: current.body!.value + 1 },
    }))

    source.emit(event, { value: 2 })

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(firstHandler.mock.calls[0][0].body).toEqual({ value: 3 })
    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler.mock.calls[0][0].body).toEqual({ value: 3 })

    pipe.dispose()
  })

  it('keeps plugins added to a child pipe scoped to that target', () => {
    const source = createContext()
    const firstTarget = createContext()
    const secondTarget = createContext()

    const event = defineEventa<{ value: number }>('channel:fan-out:child-pipe-use')

    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    firstTarget.on(event, firstHandler)
    secondTarget.on(event, secondHandler)

    const pipe = pipeChannel(source, firstTarget, secondTarget)

    pipe.pipes[0].use(current => ({
      ...current,
      body: { value: current.body!.value + 10 },
    }))

    source.emit(event, { value: 1 })

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(firstHandler.mock.calls[0][0].body).toEqual({ value: 11 })
    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler.mock.calls[0][0].body).toEqual({ value: 1 })

    pipe.dispose()
  })

  it('filters one target in a four-context fan-out while tagging the source context', () => {
    const one = createContext()
    const two = createContext()
    const three = createContext()
    const four = createContext()

    const event = defineEventa<{ value: string, sourceContext?: string }>('channel:fan-out:source-tag')

    const twoHandler = vi.fn()
    const threeHandler = vi.fn()
    const fourHandler = vi.fn()
    two.on(event, twoHandler)
    three.on(event, threeHandler)
    four.on(event, fourHandler)

    const tagSource = defineChannelPlugin(current => ({
      ...current,
      body: {
        ...current.body,
        sourceContext: 'one',
      },
    }))

    const openPipe = pipeChannel(one, two, three, { plugins: tagSource })
    const filteredPipe = pipeChannel(one, four, {
      plugins: [tagSource, current => current.body?.sourceContext === 'one' ? false : undefined],
    })

    one.emit(event, { value: 'from-one' })

    expect(twoHandler).toHaveBeenCalledTimes(1)
    expect(twoHandler.mock.calls[0][0].body).toEqual({
      value: 'from-one',
      sourceContext: 'one',
    })
    expect(threeHandler).toHaveBeenCalledTimes(1)
    expect(threeHandler.mock.calls[0][0].body).toEqual({
      value: 'from-one',
      sourceContext: 'one',
    })
    expect(fourHandler).not.toHaveBeenCalled()

    openPipe.dispose()
    filteredPipe.dispose()
  })

  it('allows plugins added with use and removes only that registered plugin', () => {
    const source = createContext()
    const target = createContext()

    const event = defineEventa<{ value: number }>('channel:use')

    const handler = vi.fn()
    target.on(event, handler)

    const pipe = pipeChannel(source, target)
    const plugin = defineChannelPlugin(current => ({
      ...current,
      body: { value: current.body!.value + 10 },
    }))
    const unuseFirst = pipe.use(plugin)
    pipe.use(plugin)

    source.emit(event, { value: 1 })
    unuseFirst()
    source.emit(event, { value: 1 })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[0][0].body).toEqual({ value: 21 })
    expect(handler.mock.calls[1][0].body).toEqual({ value: 11 })
  })

  it('passes source target and direction to plugins', () => {
    const source = createContext()
    const target = createContext()

    const event = defineEventa<{ value: string }>('channel:plugin-context')

    const plugin = vi.fn()
    pipeChannel(source, target, { plugins: plugin, direction: 'left-to-right' })
    source.emit(event, { value: 'context' })

    expect(plugin).toHaveBeenCalledTimes(1)
    expect(plugin.mock.calls[0][1]).toEqual({
      source,
      target,
      direction: 'left-to-right',
    })
  })

  it('propagates plugin errors through source emit', async () => {
    const source = createContext()
    const target = createContext()

    const event = defineEventa<{ value: string }>('channel:plugin-error')
    const expected = new Error('plugin failed')

    pipeChannel(source, target, {
      plugins: () => {
        throw expected
      },
    })

    await expect(source.emit(event, { value: 'boom' })).rejects.toBe(expected)
  })
  it('infers source and target context types for channel plugins', () => {
    interface SourceExtensions { sourceExtension: true }
    interface SourceEmitOptions { sourceOption: string }
    interface TargetExtensions { targetExtension: true }
    interface TargetEmitOptions { targetOption: number }

    const source = createContext<SourceExtensions, SourceEmitOptions>()
    const target = createContext<TargetExtensions, TargetEmitOptions>()

    const pipe = pipeChannel(source, target, {
      plugins: (_event, context) => {
        expectTypeOf(context.source).toEqualTypeOf<typeof source>()
        expectTypeOf(context.target).toEqualTypeOf<typeof target>()
        expectTypeOf(context.source.extensions).toEqualTypeOf<SourceExtensions | undefined>()
        expectTypeOf(context.target.extensions).toEqualTypeOf<TargetExtensions | undefined>()
        expectTypeOf<Parameters<typeof context.source.emit>[2]>().toEqualTypeOf<SourceEmitOptions | undefined>()
        expectTypeOf<Parameters<typeof context.target.emit>[2]>().toEqualTypeOf<TargetEmitOptions | undefined>()
      },
    })

    pipe.use((_event, context) => {
      expectTypeOf(context.source).toEqualTypeOf<typeof source>()
      expectTypeOf(context.target).toEqualTypeOf<typeof target>()
      expectTypeOf(context.source.extensions).toEqualTypeOf<SourceExtensions | undefined>()
      expectTypeOf(context.target.extensions).toEqualTypeOf<TargetExtensions | undefined>()
    })

    expectTypeOf(pipe).toEqualTypeOf<ChannelPipeGroup<SourceExtensions, SourceEmitOptions, TargetExtensions, TargetEmitOptions>>()

    pipe.dispose()
  })
})

describe('linkChannel', () => {
  it('links two existing contexts bidirectionally', () => {
    const left = createContext()
    const right = createContext()

    const ping = defineEventa<{ value: string }>('channel:pipe:ping')
    const pong = defineEventa<{ value: string }>('channel:pipe:pong')

    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(pong, leftHandler)
    right.on(ping, rightHandler)

    const linkHandle = linkChannel(left, right)

    left.emit(ping, { value: 'from-left' })
    right.emit(pong, { value: 'from-right' })

    expect(rightHandler).toHaveBeenCalledTimes(1)
    expect(rightHandler.mock.calls[0][0].body).toEqual({ value: 'from-left' })
    expect(leftHandler).toHaveBeenCalledTimes(1)
    expect(leftHandler.mock.calls[0][0].body).toEqual({ value: 'from-right' })

    linkHandle.dispose()
  })

  it('carries unary invoke events across a channel connection', async () => {
    const left = createContext()
    const right = createContext()

    const events = defineInvokeEventa<{ greeting: string }, { name: string }>('channel:pipe:invoke')

    defineInvokeHandler(right, events, ({ name }) => ({ greeting: `hello ${name}` }))

    const linkHandle = linkChannel(left, right)
    const invoke = defineInvoke(left, events)

    await expect(invoke({ name: 'alice' })).resolves.toEqual({ greeting: 'hello alice' })

    linkHandle.dispose()
  })

  it('carries request-stream invoke events across a channel connection', async () => {
    const left = createContext()
    const right = createContext()

    const events = defineInvokeEventa<number, ReadableStream<number>>('channel:pipe:invoke-request-stream')

    defineInvokeHandler(right, events, async (payload) => {
      let sum = 0

      for await (const value of payload) {
        sum += value
      }

      return sum
    })

    const linkHandle = linkChannel(left, right)
    const invoke = defineInvoke(left, events)
    const input = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })

    await expect(invoke(input)).resolves.toBe(6)

    linkHandle.dispose()
  })

  it('carries stream invoke response events across a channel connection', async () => {
    const left = createContext()
    const right = createContext()

    const events = defineInvokeEventa<{ step: number } | { result: string }, { name: string }>('channel:pipe:stream-invoke')

    defineStreamInvokeHandler(right, events, ({ name }) => {
      return (async function* () {
        yield { step: 1 }
        yield { step: 2 }
        yield { result: `done ${name}` }
      }())
    })

    const linkHandle = linkChannel(left, right)
    const invoke = defineStreamInvoke(left, events)
    const responses: Array<{ step: number } | { result: string }> = []

    for await (const response of invoke({ name: 'alice' })) {
      responses.push(response)
    }

    expect(responses).toEqual([
      { step: 1 },
      { step: 2 },
      { result: 'done alice' },
    ])

    linkHandle.dispose()
  })

  it('applies shared plugins with direction context', () => {
    const left = createContext()
    const right = createContext()
    const event = defineEventa<{ value: number }>('channel:pipe:plugins')

    const leftHandler = vi.fn()
    const rightHandler = vi.fn()

    const plugin = vi.fn(defineChannelPlugin((current, context) => ({
      ...current,
      body: { value: current.body!.value + (context.source === left ? 1 : 100) },
    })))

    right.on(event, rightHandler)
    left.on(event, leftHandler)

    const linkHandle = linkChannel(left, right, { plugins: plugin })

    left.emit(event, { value: 1 })
    right.emit(event, { value: 1 })

    expect(rightHandler).toHaveBeenCalledTimes(2)
    expect(rightHandler.mock.calls[0][0].body).toEqual({ value: 2 })
    expect(rightHandler.mock.calls[1][0].body).toEqual({ value: 1 })
    expect(leftHandler).toHaveBeenCalledTimes(2)
    expect(leftHandler.mock.calls[0][0].body).toEqual({ value: 1 })
    expect(leftHandler.mock.calls[1][0].body).toEqual({ value: 101 })
    expect(plugin).toHaveBeenCalledTimes(2)
    expect(plugin.mock.calls[0][1]).toEqual({
      source: left,
      target: right,
      direction: 'left-to-right',
    })
    expect(plugin.mock.calls[1][1]).toEqual({
      source: right,
      target: left,
      direction: 'right-to-left',
    })

    linkHandle.dispose()
  })

  it('stops both pipe directions and allows repeated dispose without aborting contexts', () => {
    const left = createContext()
    const right = createContext()
    const event = defineEventa<{ value: string }>('channel:pipe:dispose')

    const connection = linkChannel(left, right)

    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(event, leftHandler)
    right.on(event, rightHandler)

    connection.dispose()
    connection.dispose() // intended, checking for idempotent dispose

    left.emit(event, { value: 'from-left' })
    right.emit(event, { value: 'from-right' })

    expect(leftHandler).toHaveBeenCalledTimes(1)
    expect(leftHandler.mock.calls[0][0].body).toEqual({ value: 'from-left' })
    expect(rightHandler).toHaveBeenCalledTimes(1)
    expect(rightHandler.mock.calls[0][0].body).toEqual({ value: 'from-right' })
    expect(left.signal.aborted).toBe(false)
    expect(right.signal.aborted).toBe(false)
  })

  it('propagates abort across a linked mesh', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()

    const reason = new Error('mesh transport closed')

    const connection = linkChannel(first, second, third)

    second.abort(reason)

    expect(first.signal.aborted).toBe(true)
    expect(first.signal.reason).toBe(reason)
    expect(third.signal.aborted).toBe(true)
    expect(third.signal.reason).toBe(reason)

    connection.dispose()
  })

  it('can disable abort propagation for a linked mesh', () => {
    const first = createContext()
    const second = createContext()

    const reason = new Error('mesh transport closed')

    const connection = linkChannel(first, second, { propagateAbort: false })

    second.abort(reason)

    expect(first.signal.aborted).toBe(false)

    connection.dispose()
  })

  it('rejects a pending invoke when a linked remote context aborts', async () => {
    const iframe = createContext()
    const websocket = createContext()

    const events = defineInvokeEventa<{ greeting: string }, { name: string }>('channel:link:invoke-abort')
    const invoke = defineInvoke(iframe, events)

    const reason = new Error('websocket server disconnected')

    const connection = linkChannel(iframe, websocket)
    const pending = invoke({ name: 'alice' })

    websocket.abort(reason)

    await expect(pending).rejects.toBe(reason)

    connection.dispose()
  })

  it('aborts the remote invoke handler when the linked caller context aborts', async () => {
    const iframe = createContext()
    const websocket = createContext()

    const events = defineInvokeEventa<{ greeting: string }, { name: string }>('channel:link:invoke-handler-abort')
    const invoke = defineInvoke(iframe, events)

    const reason = new Error('iframe unloaded')

    let resolveStarted!: () => void
    let resolveAbortReason!: (reason: unknown) => void
    const handlerStarted = new Promise<void>(resolve => resolveStarted = resolve)
    const handlerAbortReason = new Promise<unknown>(resolve => resolveAbortReason = resolve)

    defineInvokeHandler(websocket, events, (_payload, options) => {
      resolveStarted()
      options?.abortController?.signal.addEventListener('abort', () => {
        resolveAbortReason(options.abortController?.signal.reason)
      }, { once: true })

      return new Promise(() => {})
    })

    const connection = linkChannel(iframe, websocket)
    const pending = invoke({ name: 'alice' })

    await handlerStarted
    iframe.abort(reason)

    await expect(pending).rejects.toBe(reason)
    await expect(handlerAbortReason).resolves.toBe(reason)

    connection.dispose()
  })

  it('links any number of contexts bidirectionally and applies plugins added with use', () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const event = defineEventa<{ value: number }>('channel:link:mesh')

    const secondHandler = vi.fn()
    const thirdHandler = vi.fn()
    second.on(event, secondHandler)
    third.on(event, thirdHandler)

    const connection = linkChannel(first, second, third)

    connection.use(current => ({
      ...current,
      body: { value: current.body!.value + 10 },
    }))

    first.emit(event, { value: 1 })

    expect(secondHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler.mock.calls[0][0].body).toEqual({ value: 11 })
    expect(thirdHandler).toHaveBeenCalledTimes(1)
    expect(thirdHandler.mock.calls[0][0].body).toEqual({ value: 11 })

    connection.dispose()
  })

  it('keeps plugins added to a child link pipe scoped to that directed edge', () => {
    const left = createContext()
    const right = createContext()
    const event = defineEventa<{ value: number }>('channel:link:child-pipe-use')

    const leftHandler = vi.fn()
    const rightHandler = vi.fn()
    left.on(event, leftHandler)
    right.on(event, rightHandler)

    const connection = linkChannel(left, right)

    connection.pipes[0].use(current => ({
      ...current,
      body: { value: current.body!.value + 10 },
    }))

    left.emit(event, { value: 1 })
    right.emit(event, { value: 1 })

    expect(rightHandler).toHaveBeenCalledTimes(2)
    expect(rightHandler.mock.calls[0][0].body).toEqual({ value: 11 })
    expect(rightHandler.mock.calls[1][0].body).toEqual({ value: 1 })
    expect(leftHandler).toHaveBeenCalledTimes(2)
    expect(leftHandler.mock.calls[0][0].body).toEqual({ value: 1 })
    expect(leftHandler.mock.calls[1][0].body).toEqual({ value: 1 })

    connection.dispose()
  })

  it('infers source and target context types for channel plugins', () => {
    interface SourceExtensions { sourceExtension: true }
    interface SourceEmitOptions { sourceOption: string }
    interface TargetExtensions { targetExtension: true }
    interface TargetEmitOptions { targetOption: number }

    const source = createContext<SourceExtensions, SourceEmitOptions>()
    const target = createContext<TargetExtensions, TargetEmitOptions>()

    const connection = linkChannel(source, target, {
      plugins: (_event, context) => {
        expectTypeOf(context.source).toEqualTypeOf<typeof source | typeof target>()
        expectTypeOf(context.target).toEqualTypeOf<typeof source | typeof target>()
      },
    })

    expectTypeOf(connection).toEqualTypeOf<ChannelLink<SourceExtensions, SourceEmitOptions, TargetExtensions, TargetEmitOptions>>()

    connection.dispose()
  })
})
