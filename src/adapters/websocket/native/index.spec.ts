import type { Hooks } from 'crossws'

import type { Eventa } from '../../../eventa'

import { plugin as ws } from 'crossws/server'
import { defineWebSocketHandler, H3, serve } from 'h3'
import { describe, expect, it, vi } from 'vitest'

import { createContext, wsConnectedEvent, wsDisconnectedEvent, wsErrorEvent } from '.'
import { defineEventa, nanoid } from '../../../eventa'
import { defineInvoke } from '../../../invoke'
import { defineInvokeEventa } from '../../../invoke-shared'
import { createUntil, randomBetween } from '../../../utils'

describe('browser websocket adapter', () => {
  it('should create a ws adapter and handle events from peer send', async (testCtx) => {
    const sendEvent = defineEventa<string>('send')
    const receivedEvent = defineEventa<string>('received')

    const port = randomBetween(40000, 50000)
    const app = new H3()
    app.get('/ws', defineWebSocketHandler({
      message: (peer) => {
        peer.send(JSON.stringify({
          id: nanoid(),
          type: receivedEvent.id,
          payload: {
            id: receivedEvent.id,
            type: receivedEvent.type,
            body: 'world',
          } satisfies Eventa<string>,
          timestamp: Date.now(),
          websocketType: 'outbound',
        }))
      },
    }))

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

    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    const opened = createUntil<void>({
      async intervalHandler() {
        if (wsConn.readyState === WebSocket.OPEN) {
          return true
        }

        return false
      },
    })
    wsConn.onopen = () => {
      opened.handler()
    }
    const { context: ctx } = createContext(wsConn)
    await opened.promise

    const onMessage = vi.fn()
    const untilOnMessage = createUntil<void>()
    ctx.on(receivedEvent, (payload) => {
      onMessage(payload)
      untilOnMessage.handler()
    })
    ctx.emit(sendEvent, 'hello')

    await untilOnMessage.promise
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage.mock.calls[0][0]).toBeTypeOf('object')

    const receivedData = onMessage.mock.calls[0][0] as Eventa<string>
    expect(receivedData).toEqual({ id: receivedEvent.id, type: receivedEvent.type, body: 'world', _flowDirection: 'inbound' })
  })

  it('should handle connection lifecycle events', async (testCtx) => {
    const port = randomBetween(40000, 50000)
    const app = new H3()
    app.get('/ws', defineWebSocketHandler({}))

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

    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    const opened = createUntil<void>({
      async intervalHandler() {
        if (wsConn.readyState === WebSocket.OPEN) {
          return true
        }

        return false
      },
    })
    wsConn.onopen = () => {
      opened.handler()
    }
    const { context: ctx } = createContext(wsConn)
    await opened.promise

    const untilDisconnected = createUntil<void>()

    ctx.on(wsConnectedEvent, onConnect)
    ctx.on(wsErrorEvent, onError)
    ctx.on(wsDisconnectedEvent, (payload) => {
      onDisconnect(payload)
      untilDisconnected.handler()
    })

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
    expect(disconnectData.body?.id).not.toBe('')
  })

  // ROOT CAUSE:
  //
  // Before this fix, defineInvoke() returned a promise that only resolved or
  // rejected on a per-invoke receive event. When the underlying socket closed,
  // those listeners fell silent and the promise hung forever, so any caller
  // had to maintain its own pending-RPC tracker and reject manually on
  // disconnect.
  //
  // We fixed this by registering wsDisconnectedEvent and wsErrorEvent as abort
  // events on the context inside `createContext`, with a mapAbortError that
  // produces real Error instances. defineInvoke's existing abortOnEvents
  // machinery then rejects every in-flight invoke when either event fires.
  it('issue: rejects pending invoke when socket closes mid-flight', async (testCtx) => {
    const port = randomBetween(40000, 50000)
    const app = new H3()
    // Server intentionally never replies to the invoke send, so the only path
    // out of the pending promise is the disconnect-driven abort.
    app.get('/ws', defineWebSocketHandler({}))

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

    const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
    const opened = createUntil<void>({
      async intervalHandler() {
        if (wsConn.readyState === WebSocket.OPEN) {
          return true
        }

        return false
      },
    })
    wsConn.onopen = () => {
      opened.handler()
    }
    const { context: ctx } = createContext(wsConn)
    await opened.promise

    const echoEvents = defineInvokeEventa<string, string>('test:echo')
    const invoke = defineInvoke(ctx, echoEvents)

    const invocation = invoke('hello')

    // Drop the underlying socket without ever delivering a response. The
    // adapter emits wsDisconnectedEvent, defineInvoke sees it via abortOnEvents,
    // and rejects with the mapAbortError-produced Error.
    wsConn.close()

    await expect(invocation).rejects.toThrowError(/websocket disconnected/i)
  })
})
