import type { Hooks } from 'crossws'

import { plugin as websocketPlugin } from 'crossws/server'
import { defineWebSocketHandler, H3, serve } from 'h3'
import { describe, expect, it } from 'vitest'

import { createContext as createBroadcastContext } from './adapters/broadcast-channel'
import { createContext as createEventTargetContext } from './adapters/event-target'
import { createPeerHooks } from './adapters/websocket/h3'
import { createContext as createWebSocketContext } from './adapters/websocket/native'
import { linkChannel } from './channel'
import { createContext } from './context'
import { defineInvoke, defineInvokeHandler } from './invoke'
import { defineInvokeEventa } from './invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler } from './stream'
import { createUntil, randomBetween } from './utils'

function createLinkedContexts() {
  const caller = createContext()
  const gateway = createContext()
  const handler = createContext()
  const link = linkChannel(caller, gateway, handler)
  return { caller, gateway, handler, link }
}

describe('multi-hop invoke protocols', () => {
  it('routes a response stream through an intermediate context', async () => {
    const { caller, handler, link } = createLinkedContexts()
    const events = defineInvokeEventa<number, number>('multi-hop:response-stream')
    defineStreamInvokeHandler(handler, events, count => (async function* () {
      for (let value = 1; value <= count; value++) {
        yield value
      }
    }()))

    const received: number[] = []
    for await (const value of defineStreamInvoke(caller, events)(3)) {
      received.push(value)
    }

    expect(received).toEqual([1, 2, 3])
    link.dispose()
  })

  it('routes a request stream to a unary handler through an intermediate context', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('multi-hop:request-stream')
    let notifyBlocked: () => void
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve
    })
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const link = linkChannel(caller, gateway, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          notifyBlocked()
          await gate
        }
      },
    })
    let handlerCalls = 0
    defineInvokeHandler(handler, events, async (request) => {
      handlerCalls += 1
      let total = 0
      for await (const value of request) {
        total += value
      }
      return total
    })
    const request = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })

    const result = defineInvoke(caller, events)(request)
    await blocked
    expect(handlerCalls).toBe(0)
    release!()

    await expect(result).resolves.toBe(5)
    expect(handlerCalls).toBe(1)
    link.dispose()
  })

  it('routes bidirectional stream frames through an intermediate context', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('multi-hop:bidirectional-stream')
    let notifyBlocked: () => void
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve
    })
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const link = linkChannel(caller, gateway, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          notifyBlocked()
          await gate
        }
      },
    })
    let handlerCalls = 0
    defineStreamInvokeHandler(handler, events, async function* (request) {
      handlerCalls += 1
      for await (const value of request) {
        yield value * 2
      }
    })
    const request = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(2)
        controller.enqueue(4)
        controller.close()
      },
    })

    const received: number[] = []
    const consume = (async () => {
      for await (const value of defineStreamInvoke(caller, events)(request)) {
        received.push(value)
      }
    })()
    await blocked
    expect(handlerCalls).toBe(0)
    release!()
    await consume

    expect(received).toEqual([4, 8])
    expect(handlerCalls).toBe(1)
    link.dispose()
  })

  it('orders response frames within one stream when a channel edge is asynchronous', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, undefined>('multi-hop:ordered-response-stream')
    let notifyFirstBlocked!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      notifyFirstBlocked = resolve
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const forwarded: number[] = []
    const link = linkChannel(caller, gateway, handler, {
      plugins: async (event, { target }) => {
        if (target !== caller || !event.id.startsWith(events.receiveEvent.id) || !event.body) {
          return
        }
        const content = (event.body as { content?: number }).content
        if (content === 1) {
          notifyFirstBlocked()
          await firstGate
        }
        if (typeof content === 'number') {
          forwarded.push(content)
        }
      },
    })
    defineStreamInvokeHandler(handler, events, async function* () {
      yield 1
      yield 2
    })

    const received: number[] = []
    const consume = (async () => {
      for await (const value of defineStreamInvoke(caller, events)(undefined)) {
        received.push(value)
      }
    })()
    await firstBlocked
    expect(forwarded).toEqual([])
    releaseFirst()
    await consume

    expect(forwarded).toEqual([1, 2])
    expect(received).toEqual([1, 2])
    link.dispose()
  })

  // ROOT CAUSE:
  //
  // An asynchronous request edge can let cancellation reach a streaming
  // response handler before the first request chunk. Materializing a synthetic
  // request on abort invokes the handler once, then the delayed chunk invokes
  // it again.
  //
  // We retain the cancellation as an invoke tombstone. The real first chunk
  // materializes exactly one request stream and immediately errors that stream.
  it('invokes a streaming response handler once when cancellation overtakes its first request chunk', async () => {
    const caller = createContext()
    const gateway = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('multi-hop:stream-handler-reordered-abort')
    let notifyRequestBlocked!: () => void
    const requestBlocked = new Promise<void>((resolve) => {
      notifyRequestBlocked = resolve
    })
    let releaseRequest!: () => void
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
    let handlerCalls = 0
    let handlerError: unknown
    let notifyHandlerSettled!: () => void
    const handlerSettled = new Promise<void>((resolve) => {
      notifyHandlerSettled = resolve
    })
    defineStreamInvokeHandler(handler, events, async function* (request) {
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
    const consume = (async () => {
      for await (const _value of defineStreamInvoke(caller, events)(request, { signal: controller.signal })) {
        // Cancellation rejects the response stream before it can yield values.
      }
    })()
    await requestBlocked
    controller.abort('cancelled before first chunk arrived')
    await expect(consume).rejects.toMatchObject({ name: 'AbortError' })
    releaseRequest()
    await handlerSettled
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handlerCalls).toBe(1)
    expect(handlerError).toMatchObject({ name: 'AbortError' })
    link.dispose()
  })

  it('routes handler errors back through an intermediate context', async () => {
    const { caller, handler, link } = createLinkedContexts()
    const events = defineInvokeEventa<string, string>('multi-hop:error')
    const failure = new Error('remote failure')
    defineInvokeHandler(handler, events, () => {
      throw failure
    })

    await expect(defineInvoke(caller, events)('hello')).rejects.toBe(failure)
    link.dispose()
  })
})

describe('multi-transport routing', { timeout: 3000 }, () => {
  it('invokes and aborts from EventTarget through BroadcastChannel and WebSocket', async (testContext) => {
    const port = randomBetween(40_000, 50_000)
    const app = new H3()
    const { hooks, untilLeastOneConnected } = createPeerHooks()
    app.get('/ws', defineWebSocketHandler(hooks))
    const server = serve(app, {
      port,
      plugins: [websocketPlugin({
        resolve: async (request) => {
          const response = (await app.fetch(request)) as Response & { crossws: Partial<Hooks> }
          return response.crossws
        },
      })],
    })
    testContext.onTestFinished(() => server.close())

    const socket = new WebSocket(`ws://localhost:${port}/ws`)
    const opened = createUntil<void>()
    socket.onopen = () => opened.handler()
    await opened.promise

    const iframeTarget = new EventTarget()
    const pluginView = createEventTargetContext(iframeTarget)
    const iframeGateway = createEventTargetContext(iframeTarget)
    const channelName = `eventa-multi-hop-${crypto.randomUUID()}`
    const pluginBroadcast = createBroadcastContext(new BroadcastChannel(channelName), { closeOnDispose: true })
    const gatewayBroadcast = createBroadcastContext(new BroadcastChannel(channelName), { closeOnDispose: true })
    const websocket = createWebSocketContext(socket)
    const { context: serverContext } = await untilLeastOneConnected
    const iframeLink = linkChannel(iframeGateway.context, pluginBroadcast.context)
    const gatewayLink = linkChannel(gatewayBroadcast.context, websocket.context)

    const events = defineInvokeEventa<{ output: string }, { input: string }>('integration:multi-transport')
    let handlerOptions: { raw: { message: unknown } } | undefined
    defineInvokeHandler(serverContext, events, ({ input }, options) => {
      handlerOptions = options
      return { output: input.toUpperCase() }
    })

    await expect(defineInvoke(pluginView.context, events)({ input: 'hello' }))
      .resolves
      .toEqual({ output: 'HELLO' })
    expect(handlerOptions?.raw.message).toBeDefined()

    const abortEvents = defineInvokeEventa<{ output: string }, { input: string }>('integration:multi-transport-abort')
    let notifyHandlerStarted!: () => void
    const handlerStarted = new Promise<void>((resolve) => {
      notifyHandlerStarted = resolve
    })
    let notifyHandlerAborted!: () => void
    const handlerAborted = new Promise<void>((resolve) => {
      notifyHandlerAborted = resolve
    })
    defineInvokeHandler(serverContext, abortEvents, (_request, options) => new Promise((resolve) => {
      notifyHandlerStarted()
      options?.abortController?.signal.addEventListener('abort', () => {
        notifyHandlerAborted()
        resolve({ output: 'cancelled' })
      }, { once: true })
    }))

    const controller = new AbortController()
    const pending = defineInvoke(pluginView.context, abortEvents)({ input: 'cancel me' }, { signal: controller.signal })
    await handlerStarted
    controller.abort('cancelled by plugin view')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await handlerAborted
    expect(pluginView.context.signal.aborted).toBe(false)
    expect(iframeGateway.context.signal.aborted).toBe(false)
    expect(pluginBroadcast.context.signal.aborted).toBe(false)
    expect(gatewayBroadcast.context.signal.aborted).toBe(false)
    expect(websocket.context.signal.aborted).toBe(false)
    expect(serverContext.signal.aborted).toBe(false)

    iframeLink.dispose()
    gatewayLink.dispose()
    pluginView.dispose()
    iframeGateway.dispose()
    pluginBroadcast.dispose()
    gatewayBroadcast.dispose()
    socket.close()
  })
})
