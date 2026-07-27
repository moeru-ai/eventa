import { describe, expect, it } from 'vitest'

import { createContext } from './context'
import { createTaskUpdate, defineTaskEventa } from './task'

describe('task', () => {
  it('transports typed lifecycle notifications through a context', async () => {
    const ctx = createContext()
    const task = defineTaskEventa<'synthesize' | 'encode', { samples?: number }>('media:task')
    const updates: unknown[] = []

    ctx.on(task, ({ body }) => updates.push(body))

    await ctx.emit(task, createTaskUpdate('audio-1', 'queued', { stage: 'synthesize' }))
    await ctx.emit(task, createTaskUpdate('audio-1', 'running', { stage: 'synthesize' }))
    await ctx.emit(task, createTaskUpdate('audio-1', 'completed', { stage: 'encode', data: { samples: 24_000 } }))

    expect(updates).toEqual([
      { taskId: 'audio-1', state: 'queued', stage: 'synthesize' },
      { taskId: 'audio-1', state: 'running', stage: 'synthesize' },
      { taskId: 'audio-1', state: 'completed', stage: 'encode', data: { samples: 24_000 } },
    ])
  })

  it('supports nested tasks and provider-specific error data', () => {
    expect(createTaskUpdate('turn-1:image', 'failed', {
      parentTaskId: 'turn-1',
      stage: 'sampling',
      error: { code: 'UPSTREAM_TIMEOUT', retryable: true },
    })).toEqual({
      taskId: 'turn-1:image',
      parentTaskId: 'turn-1',
      state: 'failed',
      stage: 'sampling',
      error: { code: 'UPSTREAM_TIMEOUT', retryable: true },
    })
  })
})
