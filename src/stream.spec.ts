import { describe, expect, it } from 'vitest'

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
    const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 0))

    defineStreamInvokeHandler(ctx, events, ({ name, steps }) => {
      return (async function* () {
        for (let i = 1; i <= steps; i++) {
          await sleep()
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
})
