import type { EventCallback, Event as TauriEvent } from '@tauri-apps/api/event'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createContext } from '.'
import { defineEventa, EventaFlowDirection } from '../../eventa'
import { defineInvoke } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { errorEvent } from './shared'

const tauri = vi.hoisted(() => ({
  emitTo: vi.fn(),
  getCurrentWebview: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: tauri.emitTo,
  listen: tauri.listen,
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: tauri.getCurrentWebview,
}))

function receive(payload: unknown) {
  const listener = tauri.listen.mock.calls[0][1] as EventCallback<unknown>
  const event = { event: 'eventa-message', id: 1, payload } as TauriEvent<unknown>
  listener(event)
  return event
}

describe('tauri adapter', () => {
  beforeEach(() => {
    tauri.emitTo.mockReset().mockResolvedValue(undefined)
    tauri.getCurrentWebview.mockReset().mockReturnValue({ label: 'main' })
    tauri.listen.mockReset().mockResolvedValue(tauri.unlisten)
    tauri.unlisten.mockReset().mockResolvedValue(undefined)
  })

  it('sends and receives Eventa messages', async () => {
    const target = { kind: 'Webview', label: 'settings' } as const
    const { context, dispose } = await createContext({ target })
    const event = defineEventa<{ message: string }, { feature: string }>('tauri:event', {
      metadata: { feature: 'settings' },
    })

    expect(tauri.listen).toHaveBeenCalledWith(
      'eventa-message',
      expect.any(Function),
      { target: 'main' },
    )

    await context.emit(event, { message: 'outbound' })
    expect(tauri.emitTo).toHaveBeenCalledWith(
      target,
      'eventa-message',
      expect.objectContaining({
        type: 'tauri:event',
        payload: expect.objectContaining({
          body: { message: 'outbound' },
          metadata: { feature: 'settings' },
          _flowDirection: EventaFlowDirection.Outbound,
        }),
      }),
    )

    const handler = vi.fn()
    context.on(event, handler)
    const rawEvent = receive({
      id: 'message-id',
      type: 'tauri:event',
      payload: {
        ...event,
        body: { message: 'inbound' },
        _flowDirection: EventaFlowDirection.Outbound,
      },
    })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { message: 'inbound' },
        _flowDirection: EventaFlowDirection.Inbound,
      }),
      { raw: { event: rawEvent } },
    )
    expect(tauri.emitTo).toHaveBeenCalledTimes(1)

    await dispose()
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

  it('rejects creation when Tauri listener registration fails', async () => {
    const error = new Error('listen failed')
    tauri.listen.mockRejectedValueOnce(error)

    await expect(createContext({ target: 'settings' })).rejects.toBe(error)
  })

  it('emits an adapter error for malformed messages', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => void 0)
    const { context, dispose } = await createContext({ target: 'settings' })
    const handler = vi.fn()
    context.on(errorEvent, handler)

    const rawEvent = receive({ invalid: true })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'parse',
          error: expect.any(TypeError),
        }),
      }),
      { raw: { event: rawEvent } },
    )
    expect(tauri.emitTo).not.toHaveBeenCalled()

    consoleError.mockRestore()
    await dispose()
  })

  it('does not serialize ordinary event sends', async () => {
    const error = new Error('emitTo failed')
    let rejectFirst!: (error: Error) => void
    tauri.emitTo
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      }))
      .mockResolvedValueOnce(undefined)

    const { context, dispose } = await createContext({ target: 'settings' })
    const event = defineEventa<number>('tauri:unordered')
    const first = context.emit(event, 1)
    const firstResult = expect(first).rejects.toBe(error)
    const second = context.emit(event, 2)

    expect(tauri.emitTo).toHaveBeenCalledTimes(2)
    expect(tauri.emitTo.mock.calls[1][2].payload.body).toBe(2)

    rejectFirst(error)
    await firstResult
    await expect(second).resolves.toBeUndefined()

    await dispose()
  })

  it('rejects a pending invoke when sending fails', async () => {
    const error = new Error('emitTo failed')
    tauri.emitTo.mockRejectedValueOnce(error)

    const { context, dispose } = await createContext({ target: 'settings' })
    const handler = vi.fn()
    context.on(errorEvent, handler)
    const invoke = defineInvoke(context, defineInvokeEventa<string, string>('tauri:invoke'))

    await expect(invoke('hello')).rejects.toBe(error)
    expect(context.signal.aborted).toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ body: { kind: 'fatal', error } }),
      undefined,
    )

    await dispose()
  })

  it('disposes once and stops future sends', async () => {
    const { context, dispose } = await createContext({ target: 'settings' })
    const reason = new Error('disposed')
    const event = defineEventa<number>('tauri:dispose')
    await context.emit(event, 1)

    const firstDispose = dispose(reason)
    expect(dispose()).toBe(firstDispose)
    await firstDispose
    await context.emit(event, 2)

    expect(context.signal.aborted).toBe(true)
    expect(context.signal.reason).toBe(reason)
    expect(tauri.unlisten).toHaveBeenCalledTimes(1)
    expect(tauri.emitTo).toHaveBeenCalledTimes(1)
  })
})
