import { sleep } from '@moeru/std/sleep'
import { describe, expect, it } from 'vitest'

import { linkChannel, pipeChannel } from './channel'
import { createContext } from './context'
import { defineInvokeEventa } from './invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler, toStreamHandler } from './stream'

describe('stream', () => {
  it('should handle request-stream-response pattern', async () => {
    const ctx = createContext()

    interface Parameter { type: 'parameters', name: string, age: number }
    interface Progress { type: 'progress', progress: number }
    interface Result { type: 'result', result: boolean }

    const events = defineInvokeEventa<Parameter | Progress | Result, { name: string, age: number }>()

    defineStreamInvokeHandler(ctx, events, ({ name, age }) => {
      return (async function* () {
        yield { type: 'parameters', name, age } as Parameter

        for (let i = 0; i < 5; i++) {
          yield { type: 'progress', progress: (i + 1) * 20 } as Progress
        }

        yield { type: 'result', result: true } as Result
      }())
    })

    const invoke = defineStreamInvoke(ctx, events)

    let parametersName: string | undefined
    let parametersAge: number | undefined
    let progressCalled = 0
    let resultCalled = 0

    for await (const streamResult of invoke({ name: 'alice', age: 25 })) {
      switch (streamResult.type) {
        case 'parameters':
          parametersName = streamResult.name
          parametersAge = streamResult.age
          break
        case 'progress':
          progressCalled++
          break
        case 'result':
          resultCalled++
          break
      }
    }

    expect(parametersName).toBe('alice')
    expect(parametersAge).toBe(25)
    expect(progressCalled).toBe(5)
    expect(resultCalled).toBe(1)
  })

  it('should handle request-stream-response pattern with to stream handler', async () => {
    const ctx = createContext()

    interface Parameter { type: 'parameters', name: string, age: number }
    interface Progress { type: 'progress', progress: number }
    interface Result { type: 'result', result: boolean }

    const events = defineInvokeEventa<Parameter | Progress | Result, { name: string, age: number }>()

    defineStreamInvokeHandler(ctx, events, toStreamHandler(async ({ payload, emit }) => {
      emit({ type: 'parameters', name: payload.name, age: payload.age })

      for (let i = 0; i < 5; i++) {
        emit({ type: 'progress', progress: (i + 1) * 20 } as Progress)
      }

      emit({ type: 'result', result: true } as Result)
    }))

    const invoke = defineStreamInvoke(ctx, events)

    let parametersName: string | undefined
    let parametersAge: number | undefined
    let progressCalled = 0
    let resultCalled = 0

    for await (const streamResult of invoke({ name: 'alice', age: 25 })) {
      switch (streamResult.type) {
        case 'parameters':
          parametersName = streamResult.name
          parametersAge = streamResult.age
          break
        case 'progress':
          progressCalled++
          break
        case 'result':
          resultCalled++
          break
      }
    }

    expect(parametersName).toBe('alice')
    expect(parametersAge).toBe(25)
    expect(progressCalled).toBe(5)
    expect(resultCalled).toBe(1)
  })

  it('should isolate concurrent stream invocations', async () => {
    const ctx = createContext()

    interface Parameter { name: string, steps: number }
    interface Progress { type: 'progress', name: string, step: number }
    interface Result { type: 'result', name: string }

    const events = defineInvokeEventa<Progress | Result, Parameter>()

    defineStreamInvokeHandler(ctx, events, ({ name, steps }) => {
      return (async function* () {
        for (let i = 1; i <= steps; i++) {
          await sleep(0)
          const progress: Progress = { type: 'progress', name, step: i }
          yield progress
        }

        const result: Result = { type: 'result', name }
        yield result
      }())
    })

    const invoke = defineStreamInvoke(ctx, events)

    const collect = async (payload: Parameter) => {
      const outputs: Array<Progress | Result> = []
      const stream = invoke(payload)
      for await (const value of stream) {
        outputs.push(value)
      }

      return outputs
    }

    const [alice, bob, cathy] = await Promise.all([
      collect({ name: 'alice', steps: 3 }),
      collect({ name: 'bob', steps: 2 }),
      collect({ name: 'cathy', steps: 4 }),
    ])

    expect(alice).toEqual([
      { type: 'progress', name: 'alice', step: 1 },
      { type: 'progress', name: 'alice', step: 2 },
      { type: 'progress', name: 'alice', step: 3 },
      { type: 'result', name: 'alice' },
    ])
    expect(bob).toEqual([
      { type: 'progress', name: 'bob', step: 1 },
      { type: 'progress', name: 'bob', step: 2 },
      { type: 'result', name: 'bob' },
    ])
    expect(cathy).toEqual([
      { type: 'progress', name: 'cathy', step: 1 },
      { type: 'progress', name: 'cathy', step: 2 },
      { type: 'progress', name: 'cathy', step: 3 },
      { type: 'progress', name: 'cathy', step: 4 },
      { type: 'result', name: 'cathy' },
    ])
  })

  it('should surface handler errors through receiveEventError payload', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<string, void>()
    const emittedError = new Error('stream handler failure')

    defineStreamInvokeHandler(ctx, events, () => {
      return (async function* () {
        throw emittedError
      }())
    })

    const invoke = defineStreamInvoke(ctx, events)
    const stream = invoke()

    await expect(async () => {
      for await (const _ of stream) {
        // consume to trigger error
      }
    }).rejects.toBe(emittedError)
  })

  it('should abort stream invoke and notify handler', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<string, string>()
    let handlerNotified = false

    defineStreamInvokeHandler(ctx, events, async function* (_payload, options) {
      await new Promise<void>((resolve) => {
        options?.abortController?.signal.addEventListener('abort', () => {
          handlerNotified = true
          resolve()
        }, { once: true })
      })
    })

    const invoke = defineStreamInvoke(ctx, events)
    const controller = new AbortController()
    const stream = invoke('hello', { signal: controller.signal })
    const readPromise = (async () => {
      for await (const _ of stream) {
        // consume to trigger error
      }
    })()

    controller.abort('stop')

    await expect(readPromise).rejects.toMatchObject({ name: 'AbortError' })
    await sleep(0)
    expect(handlerNotified).toBe(true)
  })

  it('should notify handler when stream is canceled', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<string, string>()
    let handlerNotified = false

    defineStreamInvokeHandler(ctx, events, async function* (_payload, options) {
      await new Promise<void>((resolve) => {
        options?.abortController?.signal.addEventListener('abort', () => {
          handlerNotified = true
          resolve()
        }, { once: true })
      })
    })

    const invoke = defineStreamInvoke(ctx, events)
    const stream = invoke('hello')
    await stream.cancel('stop')

    await sleep(0)
    expect(handlerNotified).toBe(true)
  })

  // Design: emit a paced request stream (250ms interval, 10 items),
  // abort between item 4 and 5, then assert:
  // - client stream throws AbortError
  // - handler sees AbortError from request stream
  // - only 4 items observed
  // - elapsed time falls between 4x and 5x the interval (abort timing)
  it('should abort handler when request stream is aborted', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>()

    const received: number[] = []
    let handlerNotified = false
    let handlerError: unknown

    defineStreamInvokeHandler(ctx, events, async function* (payload, options) {
      options?.abortController?.signal.addEventListener('abort', () => {
        handlerNotified = true
      }, { once: true })

      try {
        for await (const value of payload) {
          received.push(value)
          yield value
        }
      }
      catch (error) {
        handlerError = error
      }
    })

    const invoke = defineStreamInvoke(ctx, events)

    const controller = new AbortController()
    const writeIntervalMs = 250
    const totalWrites = 10

    // Simulate paced input stream
    const input = new ReadableStream<number>({
      start(streamController) {
        let count = 0
        const interval = setInterval(() => {
          count += 1
          streamController.enqueue(count)
          if (count >= totalWrites) {
            clearInterval(interval)
            streamController.close()
          }
        }, writeIntervalMs)
      },
      cancel() {
        // no-op: interval will be GC'd once stream is dropped
      },
    })

    const stream = invoke(input, { signal: controller.signal })
    const responses: number[] = []
    const readPromise = (async () => {
      try {
        for await (const value of stream) {
          responses.push(value)
        }
      }
      catch (error) {
        return error
      }
      return undefined
    })()

    const start = Date.now()
    setTimeout(() => controller.abort('stop'), writeIntervalMs * 4 + 50)

    const readError = await readPromise
    const elapsed = Date.now() - start

    expect(readError).toMatchObject({ name: 'AbortError' })
    await sleep(0)
    expect(handlerNotified).toBe(true)
    expect(handlerError).toMatchObject({ name: 'AbortError' })
    expect(received.length).toBe(4)
    expect(responses).toEqual([1, 2, 3, 4])
    expect(elapsed).toBeGreaterThanOrEqual(writeIntervalMs * 4)
    expect(elapsed).toBeLessThan(writeIntervalMs * 5)
  })

  it('should support request stream input', async () => {
    const ctx = createContext()
    const invokeDef = defineInvokeEventa<number, ReadableStream<number>>()

    const received: number[] = []

    defineStreamInvokeHandler(ctx, invokeDef, (payload) => {
      return (async function* () {
        for await (const chunk of payload) {
          received.push(chunk)
        }

        const total = received.reduce((sum, value) => sum + value, 0)
        yield total
      }())
    })

    const invoke = defineStreamInvoke(ctx, invokeDef)
    const input = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.enqueue(3)
        controller.close()
      },
    })

    const outputs: number[] = []
    for await (const value of invoke(input)) {
      outputs.push(value)
    }

    expect(received).toEqual([1, 2, 3])
    expect(outputs).toEqual([6])
  })

  it('should support request stream input with to stream handler', async () => {
    const ctx = createContext()
    const invokeDef = defineInvokeEventa<number, ReadableStream<number>>()

    defineStreamInvokeHandler(ctx, invokeDef, toStreamHandler(async ({ payload, emit }) => {
      let sum = 0
      for await (const value of payload) {
        sum += value
      }

      emit(sum)
    }))

    const invoke = defineStreamInvoke(ctx, invokeDef)
    const input = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(4)
        controller.enqueue(5)
        controller.enqueue(6)
        controller.close()
      },
    })

    const outputs: number[] = []
    for await (const value of invoke(input)) {
      outputs.push(value)
    }

    expect(outputs).toEqual([15])
  })

  // ROOT CAUSE:
  //
  // Stream invokes previously ignored both the initial request-send Promise
  // and the caller context lifetime. Either failure left reader.read() pending
  // forever because no response frame could arrive.
  //
  // The response stream now errors from the originating failure and cleans up
  // all per-invocation listeners.
  it('errors the response stream when its request send fails', async () => {
    const caller = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, number>('stream:request-send-failure')
    const failure = new Error('stream request blocked')
    const pipe = pipeChannel(caller, handler, {
      plugins: async () => {
        throw failure
      },
    })

    const read = defineStreamInvoke(caller, events)(1).getReader().read()
    await expect(read).rejects.toBe(failure)
    pipe.dispose()
  })

  it('errors the response stream when a request-stream frame send fails', async () => {
    const caller = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('stream:request-stream-send-failure')
    const failure = new Error('stream request chunk blocked')
    const pipe = pipeChannel(caller, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          throw failure
        }
      },
    })
    const request = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.close()
      },
    })

    const read = defineStreamInvoke(caller, events)(request).getReader().read()
    await expect(read).rejects.toBe(failure)
    pipe.dispose()
  })

  // ROOT CAUSE:
  //
  // Streaming invokes previously translated request iterator failures into
  // cancellation, so the handler could not distinguish a failed producer from
  // a caller abort.
  //
  // The request pump now publishes sendEventError after preceding chunks, and
  // the handler errors its reconstructed request stream with the same value.
  it('routes a request-source error to the streaming handler request stream', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<number, AsyncIterable<number>, Error, Error>('stream:request-source-error')
    const failure = new Error('stream request source failed')
    let handlerError: unknown
    let settleHandler!: () => void
    const handlerSettled = new Promise<void>((resolve) => {
      settleHandler = resolve
    })
    defineStreamInvokeHandler(ctx, events, async function* (request) {
      try {
        for await (const _value of request) {
          // Consume until the request producer reports its source error.
        }
      }
      catch (error) {
        handlerError = error
      }
      finally {
        settleHandler()
      }
    })
    const request = (async function* () {
      yield 1
      throw failure
    }())

    const read = defineStreamInvoke(ctx, events)(request).getReader().read()
    await expect(read).rejects.toBe(failure)
    await handlerSettled
    expect(handlerError).toBe(failure)
  })

  it('errors the response stream when its caller context is aborted', async () => {
    const caller = createContext()
    const events = defineInvokeEventa<number, number>('stream:caller-context-abort')
    const reason = new Error('caller transport closed')
    const read = defineStreamInvoke(caller, events)(1).getReader().read()

    caller.abort(reason)

    await expect(read).rejects.toBe(reason)
  })

  it('aborts a streaming handler when its server context is aborted', async () => {
    const caller = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, number>('stream:handler-context-abort')
    const link = linkChannel(caller, handler)
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    let notifyAborted!: () => void
    const aborted = new Promise<void>((resolve) => {
      notifyAborted = resolve
    })
    defineStreamInvokeHandler(handler, events, async function* (_request, options) {
      notifyStarted()
      await new Promise<void>((resolve) => {
        options?.abortController?.signal.addEventListener('abort', () => {
          notifyAborted()
          resolve()
        }, { once: true })
      })
    })

    const consume = (async () => {
      for await (const _value of defineStreamInvoke(caller, events)(1)) {
        // The handler finishes without yielding after observing context abort.
      }
    })()
    await started
    handler.abort(new Error('server transport closed'))

    await aborted
    await consume
    link.dispose()
  })

  it('ignores late request frames after the handler context is aborted', async () => {
    const caller = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, number>('stream:late-frames-after-context-abort')
    const link = linkChannel(caller, handler)
    let handlerCalls = 0
    defineStreamInvokeHandler(handler, events, async function* () {
      handlerCalls += 1
    })
    handler.abort(new Error('server closed'))

    await caller.emit(events.sendEvent, { invokeId: 'late-invoke', content: 1, isReqStream: true })
    await caller.emit(events.sendEvent, { invokeId: 'late-invoke', content: 2, isReqStream: true })
    await caller.emit(events.sendEventStreamEnd, { invokeId: 'late-invoke', content: undefined })

    expect(handlerCalls).toBe(0)
    link.dispose()
  })

  // ROOT CAUSE:
  //
  // Cancellation could occur while the final request chunk emit was awaiting
  // an asynchronous edge. The pump resumed afterward and sent stream-end even
  // though cancellation had already stopped this invocation.
  //
  // The pump now checks its invocation state again after every awaited chunk
  // and immediately before stream-end.
  it('does not send stream-end when canceled during the final chunk send', async () => {
    const caller = createContext()
    const handler = createContext()
    const events = defineInvokeEventa<number, ReadableStream<number>>('stream:cancel-final-chunk')
    let notifyChunkBlocked!: () => void
    const chunkBlocked = new Promise<void>((resolve) => {
      notifyChunkBlocked = resolve
    })
    let releaseChunk!: () => void
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve
    })
    let notifyAbortBlocked!: () => void
    const abortBlocked = new Promise<void>((resolve) => {
      notifyAbortBlocked = resolve
    })
    let releaseAbort!: () => void
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve
    })
    let streamEndFrames = 0
    const link = linkChannel(caller, handler, {
      plugins: async (event) => {
        if (event.id === events.sendEvent.id) {
          notifyChunkBlocked()
          await chunkGate
        }
        else if (event.id === events.sendEventAbort.id) {
          notifyAbortBlocked()
          await abortGate
        }
        else if (event.id === events.sendEventStreamEnd.id) {
          streamEndFrames += 1
        }
      },
    })
    let notifyHandlerSettled!: () => void
    const handlerSettled = new Promise<void>((resolve) => {
      notifyHandlerSettled = resolve
    })
    let handlerError: unknown
    defineStreamInvokeHandler(handler, events, async function* (request) {
      try {
        for await (const _value of request) {
          // Consume until the routed cancellation errors this request.
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
        controller.close()
      },
    })
    const reader = defineStreamInvoke(caller, events)(request).getReader()
    const read = reader.read()

    await chunkBlocked
    const cancel = reader.cancel('stop during final chunk')
    await abortBlocked
    releaseChunk()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(streamEndFrames).toBe(0)
    releaseAbort()

    await cancel
    await read
    await handlerSettled
    expect(handlerError).toMatchObject({ name: 'AbortError' })
    expect(streamEndFrames).toBe(0)
    link.dispose()
  })
})
