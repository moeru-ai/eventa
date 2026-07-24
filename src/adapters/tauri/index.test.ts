import type { EventTarget } from '@tauri-apps/api/event'

import type { Eventa } from '../../eventa'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createContext } from '.'
import { defineEventa, EventaFlowDirection } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { withRemoteMethods } from '../../invoke-remote-methods'
import { defineInvokeEventa } from '../../invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler } from '../../stream'
import { createUntil } from '../../utils'
import { generatePayload } from './internal'
import { errorEvent } from './shared'

const tauri = vi.hoisted(() => {
  interface Listener {
    active: boolean
    callback: (event: { event: string, id: number, payload: unknown }) => void
    event: string
    id: number
    target: string | { kind: string, label?: string }
    unlisten: ReturnType<typeof vi.fn>
  }

  const listeners: Listener[] = []
  let currentLabel = 'main'
  let nextListenerId = 1

  function normalizeTarget(target: string | { kind: string, label?: string }) {
    return typeof target === 'string'
      ? { kind: 'AnyLabel', label: target }
      : target
  }

  function matchesTarget(listenerTarget: Listener['target'], emittedTarget: Listener['target']) {
    const listener = normalizeTarget(listenerTarget)
    const emitted = normalizeTarget(emittedTarget)

    if (listener.kind === 'Any') {
      return true
    }
    if (listener.kind === 'AnyLabel') {
      return listener.label === emitted.label
    }

    return listener.kind === emitted.kind && listener.label === emitted.label
  }

  async function dispatch(target: Listener['target'], event: string, payload: unknown) {
    for (const listener of [...listeners]) {
      if (!listener.active || listener.event !== event || !matchesTarget(listener.target, target)) {
        continue
      }

      listener.callback({ event, id: listener.id, payload })
    }
  }

  const listen = vi.fn()
  const emitTo = vi.fn()
  const getCurrentWebview = vi.fn()

  function reset() {
    listeners.length = 0
    currentLabel = 'main'
    nextListenerId = 1

    listen.mockReset()
    emitTo.mockReset()
    getCurrentWebview.mockReset()

    listen.mockImplementation(async (event: string, callback: Listener['callback'], options?: { target?: Listener['target'] }) => {
      const listener: Listener = {
        active: true,
        callback,
        event,
        id: nextListenerId++,
        target: options?.target ?? { kind: 'Any' },
        unlisten: vi.fn(),
      }
      listener.unlisten.mockImplementation(() => {
        listener.active = false
      })
      listeners.push(listener)
      return listener.unlisten
    })

    emitTo.mockImplementation(dispatch)
    getCurrentWebview.mockImplementation(() => ({ label: currentLabel }))
  }

  return {
    dispatch,
    emitTo,
    getCurrentWebview,
    listen,
    listeners,
    reset,
    setCurrentLabel(label: string) {
      currentLabel = label
    },
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: tauri.emitTo,
  listen: tauri.listen,
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: tauri.getCurrentWebview,
}))

function webviewTarget(label: string): EventTarget {
  return { kind: 'Webview', label }
}

async function createPeer(label: string, targetLabel: string) {
  tauri.setCurrentLabel(label)
  return createContext({ target: webviewTarget(targetLabel) })
}

describe('tauri adapter', () => {
  beforeEach(() => {
    tauri.reset()
  })

  it('waits until the Tauri listener is registered', async () => {
    const listenerReady = createUntil<() => void>()
    tauri.listen.mockImplementationOnce(() => listenerReady.promise)

    let created = false
    const pending = createContext({ target: { kind: 'App' } }).then((result) => {
      created = true
      return result
    })

    await Promise.resolve()
    expect(created).toBe(false)

    listenerReady.handler(() => void 0)
    const { dispose } = await pending
    expect(created).toBe(true)
    await dispose()
  })

  it('rejects creation when Tauri listener registration fails', async () => {
    const error = new Error('listen failed')
    tauri.listen.mockRejectedValueOnce(error)

    await expect(createContext({ target: { kind: 'App' } })).rejects.toBe(error)
  })

  it('supports custom event and listener targets', async () => {
    const listenTarget = { kind: 'Window', label: 'main' } as const
    const target = { kind: 'App' } as const
    const { context, dispose } = await createContext({
      listenTarget,
      messageEventName: 'eventa-custom',
      target,
    })

    expect(tauri.listen).toHaveBeenCalledWith(
      'eventa-custom',
      expect.any(Function),
      { target: listenTarget },
    )

    await context.emit(defineEventa('tauri:custom'), undefined)
    expect(tauri.emitTo).toHaveBeenCalledWith(
      target,
      'eventa-custom',
      expect.any(Object),
    )

    await dispose()
  })

  it('can disable Tauri message transport', async () => {
    const { context, dispose } = await createContext({
      messageEventName: false,
      target: 'settings',
    })

    await context.emit(defineEventa('tauri:local'), undefined)

    expect(tauri.getCurrentWebview).not.toHaveBeenCalled()
    expect(tauri.listen).not.toHaveBeenCalled()
    expect(tauri.emitTo).not.toHaveBeenCalled()

    await dispose()
  })

  it('sends the repository Payload shape to its fixed target', async () => {
    const { context, dispose } = await createPeer('main', 'settings')
    const event = defineEventa<{ message: string }, { feature: string }, { traceId: string }>('tauri:event', {
      metadata: { feature: 'settings' },
      invokeMetadata: { traceId: 'trace-1' },
    })

    await context.emit(event, { message: 'hello' })

    expect(tauri.emitTo).toHaveBeenCalledTimes(1)
    expect(tauri.emitTo).toHaveBeenCalledWith(
      webviewTarget('settings'),
      'eventa-message',
      expect.objectContaining({
        id: expect.any(String),
        type: 'tauri:event',
        payload: expect.objectContaining({
          id: 'tauri:event',
          body: { message: 'hello' },
          metadata: { feature: 'settings' },
          invokeMetadata: { traceId: 'trace-1' },
          _flowDirection: EventaFlowDirection.Outbound,
        }),
      }),
    )

    await dispose()
  })

  it('restores the complete inbound Eventa without sending it back out', async () => {
    const { context, dispose } = await createPeer('main', 'settings')
    const event = defineEventa<{ message: string }, { feature: string }, { traceId: string }>('tauri:inbound', {
      metadata: { feature: 'inbound' },
      invokeMetadata: { traceId: 'trace-2' },
    })
    const received = createUntil<{ event: Eventa<any>, rawEvent: unknown }>()

    context.on(event, (incoming, options) => {
      received.handler({ event: incoming, rawEvent: options?.raw?.event })
    })

    const wirePayload = generatePayload(event.id, {
      ...event,
      body: { message: 'from settings' },
      _flowDirection: EventaFlowDirection.Outbound,
    })
    await tauri.dispatch(webviewTarget('main'), 'eventa-message', wirePayload)

    const result = await received.promise
    expect(result.event).toMatchObject({
      id: 'tauri:inbound',
      body: { message: 'from settings' },
      metadata: { feature: 'inbound' },
      invokeMetadata: { traceId: 'trace-2' },
      _flowDirection: EventaFlowDirection.Inbound,
    })
    expect(result.rawEvent).toMatchObject({ event: 'eventa-message', payload: wirePayload })
    expect(tauri.emitTo).not.toHaveBeenCalled()

    await dispose()
  })

  it('emits a local adapter error for malformed inbound payloads', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const { context, dispose } = await createPeer('main', 'settings')
    const received = createUntil<Error>()

    context.on(errorEvent, ({ body }) => {
      received.handler(body!.error)
    })

    await tauri.dispatch(webviewTarget('main'), 'eventa-message', { invalid: true })

    const error = await received.promise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('invalid Tauri payload id')
    expect(tauri.emitTo).not.toHaveBeenCalled()

    consoleError.mockRestore()
    await dispose()
  })

  it('supports unary invoke across two Tauri Eventa contexts', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<{ output: string }, { input: string }>('tauri:invoke')

    defineInvokeHandler(right.context, events, async ({ input }) => ({ output: input.toUpperCase() }))
    const invoke = defineInvoke(left.context, events)

    await expect(invoke({ input: 'hello' })).resolves.toEqual({ output: 'HELLO' })

    await Promise.all([left.dispose(), right.dispose()])
  })

  it('supports a streamed request with a unary response', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<number, ReadableStream<number>>('tauri:request-stream')

    defineInvokeHandler(right.context, events, async (input) => {
      let total = 0
      for await (const value of input) {
        total += value
      }
      return total
    })

    const input = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })
    const invoke = defineInvoke(left.context, events)

    await expect(invoke(input)).resolves.toBe(6)
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('supports remote method stubs between JavaScript peers', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<{ output: number }, { double: (value: number) => Promise<number> }>('tauri:remote-method')
    const remote = withRemoteMethods({ allow: true })

    remote.defineInvokeHandler(right.context, events, async ({ double }) => ({ output: await double(21) }))
    const invoke = remote.defineInvoke(left.context, events)
    const result = invoke({ double: async value => value * 2 })

    await expect(result).resolves.toEqual({ output: 42 })
    result.dispose()
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('round-trips handler Errors through JSON-safe payloads', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<never, undefined>('tauri:invoke-error')

    defineInvokeHandler(right.context, events, () => {
      throw new TypeError('remote failure', { cause: new Error('root cause') })
    })
    const invoke = defineInvoke(left.context, events)

    const error = await invoke().catch(value => value)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toMatchObject({ name: 'TypeError', message: 'remote failure' })
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toBe('root cause')

    await Promise.all([left.dispose(), right.dispose()])
  })

  it('serializes outbound sends in call order', async () => {
    const resolvers: Array<() => void> = []
    tauri.emitTo.mockImplementation(() => new Promise<void>((resolve) => {
      resolvers.push(resolve)
    }))

    const { context, dispose } = await createPeer('main', 'settings')
    const event = defineEventa<{ sequence: number }>('tauri:ordered')
    const first = context.emit(event, { sequence: 1 })
    const second = context.emit(event, { sequence: 2 })

    await Promise.resolve()
    expect(tauri.emitTo).toHaveBeenCalledTimes(1)
    expect(tauri.emitTo.mock.calls[0][2].payload.body).toEqual({ sequence: 1 })

    resolvers.shift()!()
    await first
    await Promise.resolve()
    expect(tauri.emitTo).toHaveBeenCalledTimes(2)
    expect(tauri.emitTo.mock.calls[1][2].payload.body).toEqual({ sequence: 2 })

    resolvers.shift()!()
    await second
    await dispose()
  })

  it('propagates a send failure without poisoning later sends', async () => {
    const error = new Error('emitTo failed')
    tauri.emitTo
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined)

    const { context, dispose } = await createPeer('main', 'settings')
    const event = defineEventa<string>('tauri:send-error')

    await expect(context.emit(event, 'first')).rejects.toBe(error)
    await expect(context.emit(event, 'second')).resolves.toBeUndefined()
    expect(tauri.emitTo).toHaveBeenCalledTimes(2)

    await dispose()
  })

  it('rejects a pending invoke when its Tauri send fails', async () => {
    const error = new Error('invoke emitTo failed')
    tauri.emitTo.mockRejectedValueOnce(error)

    const { context, dispose } = await createPeer('main', 'missing-peer')
    const events = defineInvokeEventa<string, string>('tauri:invoke-send-error')
    const invoke = defineInvoke(context, events)

    await expect(invoke('hello')).rejects.toBe(error)
    expect(context.signal.aborted).toBe(true)

    await dispose()
  })

  it('carries a light response stream across two contexts', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<number, { count: number }>('tauri:stream')

    defineStreamInvokeHandler(right.context, events, async function* ({ count }) {
      for (let value = 1; value <= count; value += 1) {
        yield value
      }
    })

    const invoke = defineStreamInvoke(left.context, events)
    const values: number[] = []
    for await (const value of invoke({ count: 3 })) {
      values.push(value)
    }

    expect(values).toEqual([1, 2, 3])
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('carries invoke cancellation to the remote handler', async () => {
    const left = await createPeer('left', 'right')
    const right = await createPeer('right', 'left')
    const events = defineInvokeEventa<string, string>('tauri:abort')
    const handlerStarted = createUntil<void>()
    const handlerAborted = createUntil<unknown>()

    defineInvokeHandler(right.context, events, (_payload, options) => {
      handlerStarted.handler()
      return new Promise<string>((_resolve, reject) => {
        options?.abortController?.signal.addEventListener('abort', () => {
          const reason = options.abortController?.signal.reason
          handlerAborted.handler(reason)
          reject(reason)
        }, { once: true })
      })
    })

    const controller = new AbortController()
    const invoke = defineInvoke(left.context, events)
    const pending = invoke('hello', { signal: controller.signal })
    await handlerStarted.promise

    controller.abort('stop')

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(handlerAborted.promise).resolves.toBe('stop')
    await Promise.all([left.dispose(), right.dispose()])
  })

  it('aborts pending invokes and unlistens exactly once on dispose', async () => {
    const { context, dispose } = await createPeer('main', 'missing-peer')
    const events = defineInvokeEventa<string, string>('tauri:pending')
    const invoke = defineInvoke(context, events)
    const pending = invoke('hello')
    const reason = new Error('test dispose')

    const firstDispose = dispose(reason)
    const secondDispose = dispose()

    expect(secondDispose).toBe(firstDispose)
    await expect(pending).rejects.toBe(reason)
    await firstDispose
    expect(tauri.listeners[0].unlisten).toHaveBeenCalledTimes(1)

    tauri.emitTo.mockClear()
    await context.emit(defineEventa('tauri:after-dispose'), undefined)
    expect(tauri.emitTo).not.toHaveBeenCalled()
  })
})
