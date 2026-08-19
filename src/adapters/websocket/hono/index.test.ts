import type { WSContext, WSEvents } from 'hono/ws'

import type { HonoWsInvocableEventContext } from '.'

import { describe, expect, it, vi } from 'vitest'

import { createGlobalHooks, createPeerHooks, wsConnectedEvent, wsDisconnectedEvent } from '.'
import { WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE, WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON } from '..'
import { defineEventa, defineInvoke, defineInvokeEventa, defineInvokeHandler } from '../../..'

function createMockWSContext(): WSContext & { sentMessages: string[] } {
  const sentMessages: string[] = []

  return {
    send: vi.fn((data: string | ArrayBuffer | Uint8Array) => {
      sentMessages.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    close: vi.fn(),
    readyState: 1,
    raw: {},
    url: null,
    protocol: null,
    sentMessages,
  } as unknown as WSContext & { sentMessages: string[] }
}

function createMessageEvent(data: string): Parameters<NonNullable<WSEvents['onMessage']>>[0] {
  return { data } as Parameters<NonNullable<WSEvents['onMessage']>>[0]
}

describe('hono websocket adapter', () => {
  // ROOT CAUSE:
  //
  // Hono lifecycle hooks cannot return the Context emit promise to a caller.
  // Ignoring a listener or Channel rejection therefore leaked an unhandled
  // promise from open and close callbacks. The adapter now observes and reports
  // those lifecycle emit failures.
  it('reports a rejected global lifecycle emit', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const failure = new Error('open listener failed')
    const { context, hooks } = createGlobalHooks()
    context.on(wsConnectedEvent, () => {
      throw failure
    })

    hooks.onOpen?.(new Event('open'), createMockWSContext())
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(consoleError).toHaveBeenCalledWith('Failed to emit Hono WebSocket open event:', failure)
    consoleError.mockRestore()
  })

  it('creates a peer context on open and emits disconnect on close', () => {
    const onContext = vi.fn()
    const onDisconnect = vi.fn()
    const { hooks } = createPeerHooks({
      onContext(ctx) {
        onContext(ctx)
        ctx.on(wsDisconnectedEvent, onDisconnect)
      },
    })

    const ws = createMockWSContext()
    hooks.onOpen?.(new Event('open'), ws)

    expect(onContext).toHaveBeenCalledOnce()

    hooks.onClose?.(new CloseEvent('close'), ws)

    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it('routes inbound invoke messages to the peer context and sends responses', async () => {
    const echo = defineInvokeEventa<{ out: string }, { in: string }>('test:hono:echo')
    const invokeId = 'invoke-1'

    const { hooks } = createPeerHooks({
      onContext(ctx) {
        defineInvokeHandler(ctx, echo, req => ({ out: req.in.toUpperCase() }))
      },
    })

    const ws = createMockWSContext()
    hooks.onOpen?.(new Event('open'), ws)
    hooks.onMessage?.(createMessageEvent(JSON.stringify({
      deliveryId: 'hono-invoke-delivery',
      hopsRemaining: 32,
      eventa: {
        id: echo.sendEvent.id,
        type: echo.sendEvent.type,
        body: {
          invokeId,
          content: { in: 'hello' },
        },
      },
    })), ws)

    await new Promise(resolve => setTimeout(resolve, 20))

    const responses = ws.sentMessages
      .map(message => JSON.parse(message))
      .filter(message => message.eventa.id === `${echo.receiveEvent.id}-${invokeId}`)

    expect(responses).toHaveLength(1)
    expect(responses[0].eventa.body.invokeId).toBe(invokeId)
    expect(responses[0].eventa.body.content).toEqual({ out: 'HELLO' })
  })

  it('forwards outbound peer context events over the wire', () => {
    const ping = defineEventa<{ msg: string }>('test:hono:ping')
    let capturedContext: HonoWsInvocableEventContext | undefined

    const { hooks } = createPeerHooks({
      onContext(ctx) {
        capturedContext = ctx
      },
    })

    const ws = createMockWSContext()
    hooks.onOpen?.(new Event('open'), ws)
    ws.sentMessages.length = 0

    capturedContext!.emit(ping, { msg: 'pong' })

    expect(ws.sentMessages).toHaveLength(1)

    const sent = JSON.parse(ws.sentMessages[0])
    expect(sent.eventa.id).toBe(ping.id)
    expect(sent.eventa.body).toEqual({ msg: 'pong' })
  })

  // ROOT CAUSE:
  //
  // The AIRI-local Hono adapter emitted a disconnect event but did not abort
  // the per-peer EventContext lifetime. A server-side defineInvoke() back to
  // the Hono peer would then wait forever if the socket closed before a
  // response arrived. The H3 and native websocket adapters already cascade
  // close/error into ctx.abort(...); Hono must keep the same contract.
  it('rejects pending peer invokes when the socket closes', async () => {
    let capturedContext: HonoWsInvocableEventContext | undefined
    const { hooks } = createPeerHooks({
      onContext(ctx) {
        capturedContext = ctx
      },
    })

    const ws = createMockWSContext()
    hooks.onOpen?.(new Event('open'), ws)

    const event = defineInvokeEventa<string, string>('test:hono:abort')
    const invoke = defineInvoke(capturedContext!, event)
    const pending = invoke('hello')

    hooks.onClose?.(new CloseEvent('close'), ws)

    await expect(pending).rejects.toThrowError(/hono websocket disconnected/i)
  })

  it('broadcasts outbound global context events to connected peers', () => {
    const ping = defineEventa<{ msg: string }>('test:hono:global')
    const { context, hooks } = createGlobalHooks()
    const peerA = createMockWSContext()
    const peerB = createMockWSContext()

    hooks.onOpen?.(new Event('open'), peerA)
    hooks.onOpen?.(new Event('open'), peerB)
    peerA.sentMessages.length = 0
    peerB.sentMessages.length = 0
    context.emit(ping, { msg: 'hello' })

    expect(peerA.sentMessages).toHaveLength(1)
    expect(peerB.sentMessages).toHaveLength(1)
    expect(JSON.parse(peerA.sentMessages[0]).eventa.body).toEqual({ msg: 'hello' })
    expect(JSON.parse(peerB.sentMessages[0]).eventa.body).toEqual({ msg: 'hello' })
  })

  it('routes inbound messages through the global context', async () => {
    const ping = defineEventa<{ msg: string }>('test:hono:global-inbound')
    const { context, hooks } = createGlobalHooks()
    const handler = vi.fn()
    const ws = createMockWSContext()

    context.on(ping, handler)
    hooks.onOpen?.(new Event('open'), ws)
    hooks.onMessage?.(createMessageEvent(JSON.stringify({
      deliveryId: 'hono-global-inbound-delivery',
      hopsRemaining: 32,
      eventa: {
        id: ping.id,
        type: ping.type,
        body: { msg: 'hello' },
      },
    })), ws)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].body).toEqual({ msg: 'hello' })
  })

  it('closes a peer once when it sends unsupported protocol frames', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const { hooks } = createPeerHooks()
    const ws = createMockWSContext()

    hooks.onOpen?.(new Event('open'), ws)
    hooks.onMessage?.(createMessageEvent('{"type":"legacy"}'), ws)
    hooks.onMessage?.(createMessageEvent('{"type":"legacy-again"}'), ws)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ws.close).toHaveBeenCalledOnce()
    expect(ws.close).toHaveBeenCalledWith(
      WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE,
      WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON,
    )
    expect(consoleError).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to parse WebSocket message:',
      expect.any(TypeError),
    )
    consoleError.mockRestore()
  })

  it('isolates an unsupported global peer without closing healthy peers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const ping = defineEventa<{ msg: string }>('test:hono:healthy-peer')
    const { context, hooks } = createGlobalHooks()
    const unsupportedPeer = createMockWSContext()
    const healthyPeer = createMockWSContext()

    hooks.onOpen?.(new Event('open'), unsupportedPeer)
    hooks.onOpen?.(new Event('open'), healthyPeer)
    unsupportedPeer.sentMessages.length = 0
    healthyPeer.sentMessages.length = 0

    hooks.onMessage?.(createMessageEvent('{"type":"legacy"}'), unsupportedPeer)
    hooks.onMessage?.(createMessageEvent('{"type":"legacy-again"}'), unsupportedPeer)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(healthyPeer.sentMessages).toHaveLength(0)

    context.emit(ping, { msg: 'still-connected' })

    expect(unsupportedPeer.close).toHaveBeenCalledOnce()
    expect(unsupportedPeer.sentMessages).toHaveLength(0)
    expect(healthyPeer.close).not.toHaveBeenCalled()
    expect(healthyPeer.sentMessages).toHaveLength(1)
    expect(JSON.parse(healthyPeer.sentMessages[0]).eventa.id).toBe(ping.id)
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})
