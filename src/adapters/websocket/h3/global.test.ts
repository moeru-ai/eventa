import type { Hooks, Message, Peer } from 'crossws'

import type { Eventa } from '../../../eventa'

import { plugin as ws } from 'crossws/server'
import { defineWebSocketHandler, H3, serve } from 'h3'
import { describe, expect, it, vi } from 'vitest'

import { defineEventa } from '../../../eventa'
import { createUntil, randomBetween } from '../../../utils'
import { WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE, WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON } from '../protocol'
import { createGlobalContext, wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from './global'

describe('h3 websocket adapter', { timeout: 2000 }, async () => {
  it('does not broadcast one peer protocol error to healthy peers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const ping = defineEventa<{ msg: string }>('test:h3:healthy-peer')
    const { websocketHandlers, context } = createGlobalContext()
    const unsupportedPeer = {
      close: vi.fn(),
      id: 'unsupported-peer',
      send: vi.fn(),
    } as unknown as Peer
    const healthyPeer = {
      close: vi.fn(),
      id: 'healthy-peer',
      send: vi.fn(),
    } as unknown as Peer
    const legacyMessage = {
      text: () => '{"type":"legacy"}',
    } as Message

    websocketHandlers.open(unsupportedPeer)
    websocketHandlers.open(healthyPeer)
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.mocked(unsupportedPeer.send).mockClear()
    vi.mocked(healthyPeer.send).mockClear()

    websocketHandlers.message(unsupportedPeer, legacyMessage)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(healthyPeer.send).not.toHaveBeenCalled()

    await context.emit(ping, { msg: 'still-connected' })

    expect(healthyPeer.send).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(healthyPeer.send).mock.calls[0][0] as string).eventa.id).toBe(ping.id)
    consoleError.mockRestore()
  })

  it('should create a h3 ws adapter and handle events with native', async (testCtx) => {
    const port = randomBetween(40000, 50000)
    const { websocketHandlers, context: ctx } = createGlobalContext()
    const app = new H3()
    app.get('/ws', defineWebSocketHandler(websocketHandlers))

    {
      const server = serve(app, {
        port,
        plugins: [ws({
          resolve: async (req) => {
            const response = (await app.fetch(req)) as Response & { crossws: Partial<Hooks> }
            return response.crossws
          },
        })],
      })
      testCtx.onTestFinished(() => {
        server.close()
      })
    }

    const opened = createUntil<void>()
    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    wsConn.onopen = () => opened.handler()
    await opened.promise
    expect(wsConn.readyState).toBe(WebSocket.OPEN)

    const helloEvent = defineEventa<{ result: string }>('hello')

    const untilHelloEventTriggered1 = createUntil<void>()
    const handleHello = vi.fn()

    ctx.on(helloEvent, (payload, options) => {
      handleHello(payload, options)
      untilHelloEventTriggered1.handler()
    })

    // Native send
    wsConn.send(JSON.stringify({
      deliveryId: 'h3-native-inbound-delivery',
      hopsRemaining: 32,
      eventa: {
        id: helloEvent.id,
        type: helloEvent.type,
        body: { result: 'Hello' },
      },
    }))
    // Context passive send
    ctx.emit(helloEvent, { result: 'Hello' }, { raw: { message: { } as Message } })

    await untilHelloEventTriggered1.promise
    wsConn.close()

    expect(handleHello).toHaveBeenCalledTimes(1)
    expect(handleHello.mock.calls[0][0]).toEqual({ id: helloEvent.id, type: helloEvent.type, body: { result: 'Hello' } })
    expect(handleHello.mock.calls[0][1]).toBeTypeOf('object')
    expect(handleHello.mock.calls[0][1].raw).toBeTypeOf('object')
    expect(handleHello.mock.calls[0][1].raw).toHaveProperty('message')
  })

  it('should create a h3 ws adapter and handle events with context', async (testCtx) => {
    const port = randomBetween(40000, 50000)
    const { websocketHandlers, context: ctx } = createGlobalContext()
    const app = new H3()
    app.get('/ws', defineWebSocketHandler(websocketHandlers))

    {
      const server = serve(app, {
        port,
        plugins: [ws({
          resolve: async (req) => {
            const response = (await app.fetch(req)) as Response & { crossws: Partial<Hooks> }
            return response.crossws
          },
        })],
      })
      testCtx.onTestFinished(() => {
        server.close()
      })
    }

    const opened = createUntil<void>()
    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    wsConn.onopen = () => opened.handler()
    await opened.promise
    expect(wsConn.readyState).toBe(WebSocket.OPEN)

    const helloEvent = defineEventa<{ result: string }>('hello')

    const untilHelloEventTriggered1 = createUntil<void>()
    const handleHello = vi.fn()

    ctx.on(helloEvent, (payload, options) => {
      handleHello(payload, options)
      untilHelloEventTriggered1.handler()
    })

    // Context passive send
    ctx.emit(helloEvent, { result: 'Hello' }, { raw: { message: { } as Message } })

    await untilHelloEventTriggered1.promise
    wsConn.close()

    expect(handleHello).toHaveBeenCalledTimes(1)
    expect(handleHello.mock.calls[0][0]).toEqual({ id: helloEvent.id, type: helloEvent.type, body: { result: 'Hello' } })
    expect(handleHello.mock.calls[0][1]).toBeTypeOf('object')
    expect(handleHello.mock.calls[0][1].raw).toBeTypeOf('object')
    expect(handleHello.mock.calls[0][1].raw).toHaveProperty('message')
  })

  it('should handle connection lifecycle events', async (testCtx) => {
    const port = randomBetween(40000, 50000)
    const { websocketHandlers, context: ctx } = createGlobalContext()
    const app = new H3()
    app.get('/ws', defineWebSocketHandler(websocketHandlers))

    {
      const server = serve(app, {
        port,
        plugins: [ws({
          resolve: async (req) => {
            const response = (await app.fetch(req)) as Response & { crossws: Partial<Hooks> }
            return response.crossws
          },
        })],
      })
      testCtx.onTestFinished(() => {
        server.close()
      })
    }

    const onConnect = vi.fn()
    const onError = vi.fn()
    const onDisconnect = vi.fn()

    const untilDisconnected = createUntil<void>()

    ctx.on(wsConnectedEvent, onConnect)
    ctx.on(wsErrorEvent, onError)
    ctx.on(wsDisconnectedEvent, (payload) => {
      onDisconnect(payload)
      untilDisconnected.handler()
    })

    const opened = createUntil<void>()
    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    wsConn.onopen = () => opened.handler()
    await opened.promise
    expect(wsConn.readyState).toBe(WebSocket.OPEN)

    expect(onConnect).toHaveBeenCalledOnce()
    expect(onConnect.mock.calls[0][0]).toBeTypeOf('object')

    const connectData = onConnect.mock.calls[0][0] as Eventa<{ id: string }>

    expect(connectData.id).toBeTypeOf('string')
    expect(connectData.body).toBeTypeOf('object')
    expect(connectData.body?.id).not.equal('')

    const error = new Error('test error')
    ctx.emit(wsErrorEvent, { error })

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toBeTypeOf('object')

    const errorData = onError.mock.calls[0][0] as Eventa<{ error: unknown }>

    expect(errorData.id).toBe(wsErrorEvent.id)
    expect(errorData.body).toMatchObject({ error })

    wsConn.close()
    await untilDisconnected.promise

    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onDisconnect.mock.calls[0][0]).toBeTypeOf('object')

    const disconnectData = onDisconnect.mock.calls[0][0] as Eventa<{ id: string }>

    expect(disconnectData.id).toBe(wsDisconnectedEvent.id)
    expect(disconnectData.body).toBeTypeOf('object')
    expect(disconnectData.body?.id).toBe(connectData.body?.id)
  })

  it('closes a peer that sends an unsupported protocol frame', async (testCtx) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    testCtx.onTestFinished(() => consoleError.mockRestore())
    const port = randomBetween(40000, 50000)
    const { websocketHandlers } = createGlobalContext()
    const app = new H3()
    app.get('/ws', defineWebSocketHandler(websocketHandlers))

    const server = serve(app, {
      port,
      plugins: [ws({
        resolve: async (req) => {
          const response = (await app.fetch(req)) as Response & { crossws: Partial<Hooks> }
          return response.crossws
        },
      })],
    })
    testCtx.onTestFinished(() => server.close())

    const opened = createUntil<void>()
    const closed = createUntil<CloseEvent>()
    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    wsConn.onopen = () => opened.handler()
    wsConn.onclose = event => closed.handler(event)
    await opened.promise

    wsConn.send('{"type":"legacy"}')
    const closeEvent = await closed.promise

    expect(closeEvent.code).toBe(WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE)
    expect(closeEvent.reason).toBe(WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON)
    expect(consoleError).toHaveBeenCalledOnce()
  })
})
