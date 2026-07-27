import { describe, expect, it } from 'vitest'

import { createContext } from './context'
import { createProgressUpdate, defineProgressEventa } from './progress'

describe('progress', () => {
  it('creates typed lifecycle updates that can travel through a context', async () => {
    const ctx = createContext()
    const progress = defineProgressEventa<'download' | 'decode', { bytes?: number }>('media:progress')
    const updates: unknown[] = []

    ctx.on(progress, ({ body }) => updates.push(body))

    await ctx.emit(progress, createProgressUpdate('queued', { taskId: 'audio-1', stage: 'download' }))
    await ctx.emit(progress, createProgressUpdate('running', { stage: 'download', progress: 0.5, data: { bytes: 512 } }))
    await ctx.emit(progress, createProgressUpdate('completed', { stage: 'decode', progress: 1 }))

    expect(updates).toEqual([
      { type: 'progress', status: 'queued', taskId: 'audio-1', stage: 'download' },
      { type: 'progress', status: 'running', stage: 'download', progress: 0.5, data: { bytes: 512 } },
      { type: 'progress', status: 'completed', stage: 'decode', progress: 1 },
    ])
  })

  it('rejects progress values outside the normalized range', () => {
    expect(() => createProgressUpdate('running', { progress: -0.1 })).toThrow(RangeError)
    expect(() => createProgressUpdate('running', { progress: 1.1 })).toThrow(RangeError)
    expect(() => createProgressUpdate('running', { progress: Number.NaN })).toThrow(RangeError)
  })
})
