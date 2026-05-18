/// <reference types="vitest" />

import type { Worker } from 'node:worker_threads'

import { MessageChannel } from 'node:worker_threads'

import { describe, expect, it, vi } from 'vitest'

import { createContext as createMainContext } from '.'
import { defineEventa } from '../../eventa'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { withTransfer } from '../../invoke-extension-transfer'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntilTriggered } from '../../utils'
import { createContext as createWorkerContext } from './worker'
import { TypeScriptWorker } from './worker/test-worker-helper'

describe('node worker adapter', async () => {
  it('should invoke across message ports', async () => {
    const { port1, port2 } = new MessageChannel()
    const { context: mainCtx } = createMainContext(port1 as unknown as Worker)
    const { context: workerCtx } = createWorkerContext({ messagePort: port2 })

    const invokeEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-invoke')
    defineInvokeHandler(workerCtx, invokeEvents, ({ input }) => ({ output: `Worker received: ${input}` }))

    const invoke = defineInvoke(mainCtx, invokeEvents)
    const res = await invoke({ input: 'Hello, Worker!' })
    expect(res.output).toBe('Worker received: Hello, Worker!')

    port1.close()
    port2.close()
  })

  it('should invoke with transfer lists', async () => {
    const { port1, port2 } = new MessageChannel()
    const { context: mainCtx } = createMainContext(port1 as unknown as Worker)
    const { context: workerCtx } = createWorkerContext({ messagePort: port2 })

    const invokeEvents = defineInvokeEventa<{ output: string }, { input: { message: string, data: ArrayBuffer } }>('node-worker-transfer-invoke')
    defineInvokeHandler(workerCtx, invokeEvents, ({ input }) => ({ output: `Worker received: ${input.message}, ${input.data.byteLength} bytes` }))

    const invoke = defineInvoke(mainCtx, invokeEvents)
    const buffer = new ArrayBuffer(16)
    const res = await invoke({ input: { message: 'Hello, Worker!', data: buffer } }, { transfer: [buffer] })
    expect(res.output).toBe('Worker received: Hello, Worker!, 16 bytes')

    port1.close()
    port2.close()
  })

  it('should handle transfer returned from worker', async () => {
    const { port1, port2 } = new MessageChannel()
    const { context: mainCtx } = createMainContext(port1 as unknown as Worker)
    const { context: workerCtx } = createWorkerContext({ messagePort: port2 })

    const invokeEvents = defineInvokeEventa<{ output: string, buffer: ArrayBuffer }>('node-worker-return-transfer')
    defineInvokeHandler(workerCtx, invokeEvents, () => {
      const buffer = new ArrayBuffer(32)
      return withTransfer({ output: 'Hello from worker!', buffer }, [buffer])
    })

    const invoke = defineInvoke(mainCtx, invokeEvents)
    const res = await invoke()
    expect(res.output).toBe('Hello from worker!')
    expect(res.buffer).toBeInstanceOf(ArrayBuffer)
    expect(res.buffer.byteLength).toBe(32)

    port1.close()
    port2.close()
  })

  it('should work with real worker thread script', async () => {
    const worker = new TypeScriptWorker(new URL('./worker/test-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
    })
    const { context: mainCtx } = createMainContext(worker)

    const invokeEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-invoke')
    const invoke = defineInvoke(mainCtx, invokeEvents)
    const res = await invoke({ input: 'Hello, Worker!' })
    expect(res.output).toBe('Worker received: Hello, Worker!')

    const invokeFromWorkerThreadForMainThread = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-from-worker-invoke-for-main-thread')
    defineInvokeHandler(mainCtx, invokeFromWorkerThreadForMainThread, ({ input }) => ({ output: `Worker received: ${input}` }))

    const invokeFromWorkerThreadEvents = defineInvokeEventa<Promise<{ output: string }>>('node-worker-from-worker-invoke')
    const invokeFromWorker = defineInvoke(mainCtx, invokeFromWorkerThreadEvents)
    const fromWorkerRes = await invokeFromWorker()
    expect(fromWorkerRes.output).toBe('Worker received: Hello from worker thread!')

    await worker.terminate()
  })

  it('should handle errors worker thread throws errors', async () => {
    const worker = new TypeScriptWorker(new URL('./worker/test-worker-errored.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
    })
    const { context: mainCtx } = createMainContext(worker)

    const loadedEventa = defineEventa<string>('test-worker-loaded-event')

    const until = createUntilTriggered(() => {})
    const loadedHandler = vi.fn()
    mainCtx.on(loadedEventa, (payload) => {
      until.handler()
      loadedHandler(payload)
    })

    await until.promise
    expect(loadedHandler).toBeCalled()
    expect(loadedHandler.mock.calls[0][0]).toStrictEqual({
      _flowDirection: 'inbound',
      body: 'loaded',
      id: 'test-worker-loaded-event',
      type: 'event',
    })

    const invokeEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-invoke')
    const invoke = defineInvoke(mainCtx, invokeEvents)
    await expect(invoke({ input: 'Hello, Worker!' }))
      .rejects
      .toThrowError(/Test error that should be caught by main thread./)

    await worker.terminate()
  })
})
