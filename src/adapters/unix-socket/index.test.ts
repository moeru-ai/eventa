import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { connect, createServer, unixSocketDisconnectedEvent } from '.'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { defineStreamInvoke, defineStreamInvokeHandler } from '../../stream'

async function createSocketPath() {
  const directory = await mkdtemp(join(tmpdir(), 'eventa-unix-socket-'))
  return { directory, path: join(directory, 'eventa.sock') }
}

describe('unix socket adapter', () => {
  it('routes unary and streaming invokes across a Unix socket', async () => {
    const { directory, path } = await createSocketPath()
    const unary = defineInvokeEventa<{ output: string }, { input: string }>('unix-socket:unary')
    const stream = defineInvokeEventa<number, number>('unix-socket:stream')
    let serverConnectionReady!: () => void
    const serverConnection = new Promise<void>((resolve) => {
      serverConnectionReady = resolve
    })
    const server = await createServer(path, ({ context }) => {
      defineInvokeHandler(context, unary, ({ input }) => ({ output: input.toUpperCase() }))
      defineStreamInvokeHandler(context, stream, async function* (count) {
        for (let value = 1; value <= count; value++)
          yield value
      })
      serverConnectionReady()
    })
    const client = await connect(path)

    try {
      await serverConnection
      await expect(defineInvoke(client.context, unary)({ input: 'hello' })).resolves.toEqual({ output: 'HELLO' })
      const received: number[] = []
      for await (const value of defineStreamInvoke(client.context, stream)(3))
        received.push(value)
      expect(received).toEqual([1, 2, 3])
    }
    finally {
      client.dispose()
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('aborts pending invokes when the peer disconnects', async () => {
    const { directory, path } = await createSocketPath()
    const pending = defineInvokeEventa<void, void>('unix-socket:pending')
    let serverConnectionReady!: () => void
    const serverConnection = new Promise<void>((resolve) => {
      serverConnectionReady = resolve
    })
    const server = await createServer(path, ({ context, dispose }) => {
      defineInvokeHandler(context, pending, async () => new Promise<void>(() => {}))
      serverConnectionReady()
      setTimeout(() => dispose(new Error('peer closed')), 0)
    })
    const client = await connect(path)
    const disconnected = vi.fn()
    client.context.on(unixSocketDisconnectedEvent, disconnected)

    try {
      await serverConnection
      await expect(defineInvoke(client.context, pending)()).rejects.toThrow(/Unix socket/i)
      expect(disconnected).toHaveBeenCalledOnce()
    }
    finally {
      client.dispose()
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
