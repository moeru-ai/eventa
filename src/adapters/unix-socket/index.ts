import type { Socket } from 'node:net'

import type { CreateContextOptions, EventContext } from '../../context'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { createConnection, createServer as createNetServer } from 'node:net'

import { createContext as createBaseContext } from '../../context'
import { and, defineEventa, EventaFlowDirection, matchBy } from '../../eventa'
import { toError } from '../errors'
import { createOutboundInner, restoreInner } from '../internal'

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

export const unixSocketDisconnectedEvent = defineEventa<{ hadError: boolean }>()
export const unixSocketErrorEvent = defineEventa<{ error: Error }>()

/** Options for the Node.js Unix-domain-socket adapter. */
export interface UnixSocketAdapterOptions {
  /** Delivery deduplication and hop policy for the created Context. */
  context?: CreateContextOptions
  /** Largest accepted JSON frame in bytes. @default 1048576 */
  maxFrameBytes?: number
}

/** Raw socket metadata available to Eventa listeners. */
export interface UnixSocketEmitOptions {
  raw: { message?: unknown, error?: Error, hadError?: boolean }
}

/** A context bound to one connected Unix socket. */
export interface UnixSocketConnection {
  context: EventContext<undefined, UnixSocketEmitOptions>
  /** Aborts pending invokes and closes the owned socket. */
  dispose: (reason?: unknown) => void
}

/** A listening Unix socket server and every context it owns. */
export interface UnixSocketServer {
  close: () => Promise<void>
}

class FramedSocket extends EventEmitter {
  #buffer = Buffer.alloc(0)
  #closed = false

  constructor(private readonly socket: Socket, private readonly maxFrameBytes: number) {
    super()
    socket.on('data', chunk => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    socket.on('error', (error) => {
      if (this.listenerCount('error') > 0)
        super.emit('error', error)
    })
    socket.on('close', (hadError) => {
      this.#closed = true
      super.emit('close', hadError)
    })
  }

  send(frame: unknown): boolean {
    if (this.#closed || this.socket.destroyed)
      return false

    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`)
    if (encoded.byteLength > this.maxFrameBytes) {
      this.socket.destroy(new Error(`Eventa Unix socket frame exceeds ${this.maxFrameBytes} bytes`))
      return false
    }
    return this.socket.write(encoded)
  }

  close(): void {
    if (!this.#closed && !this.socket.destroyed)
      this.socket.end()
  }

  private receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.byteLength > this.maxFrameBytes * 2) {
      this.socket.destroy(new Error(`Eventa Unix socket buffer exceeds ${this.maxFrameBytes * 2} bytes`))
      return
    }

    let delimiter = this.#buffer.indexOf(0x0A)
    while (delimiter >= 0) {
      const rawFrame = this.#buffer.subarray(0, delimiter)
      this.#buffer = this.#buffer.subarray(delimiter + 1)
      delimiter = this.#buffer.indexOf(0x0A)

      if (rawFrame.byteLength === 0)
        continue
      if (rawFrame.byteLength > this.maxFrameBytes) {
        this.socket.destroy(new Error(`Eventa Unix socket frame exceeds ${this.maxFrameBytes} bytes`))
        return
      }

      try {
        super.emit('message', JSON.parse(rawFrame.toString('utf8')))
      }
      catch (error) {
        this.socket.destroy(toError(error, 'eventa: invalid Unix socket frame'))
        return
      }
    }
  }
}

function resolveMaxFrameBytes(value: number | undefined): number {
  const maxFrameBytes = value ?? DEFAULT_MAX_FRAME_BYTES
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
    throw new RangeError('maxFrameBytes must be a positive safe integer.')
  return maxFrameBytes
}

/** Creates an Eventa Context backed by a connected Node.js Unix socket. */
export function createContext(socket: Socket, options: UnixSocketAdapterOptions = {}): UnixSocketConnection {
  const ctx = createBaseContext<undefined, UnixSocketEmitOptions>(options.context)
  const framedSocket = new FramedSocket(socket, resolveMaxFrameBytes(options.maxFrameBytes))
  let disposed = false
  let dispose: (reason?: unknown, closeSocket?: boolean) => void

  const stopSending = ctx.on(and(
    matchBy(event => !('_flowDirection' in event) || !event._flowDirection || event._flowDirection === EventaFlowDirection.Outbound),
    matchBy('*'),
  ), (event) => {
    const inner = createOutboundInner(event)
    if (inner && !framedSocket.send(inner))
      dispose(new Error('eventa: invoke cancelled, Unix socket disconnected'), false)
  })

  dispose = (reason?: unknown, closeSocket = true) => {
    if (disposed)
      return
    disposed = true
    stopSending()
    ctx.abort(reason ?? new Error('eventa: invoke cancelled, Unix socket adapter disposed'))
    if (closeSocket)
      framedSocket.close()
  }

  framedSocket.on('message', (message) => {
    try {
      const inner = restoreInner(message)
      void ctx.emit(inner.eventa, inner.eventa.body, { raw: { message } }).catch(emitError => console.error('Failed to emit Unix socket message:', emitError))
    }
    catch (error) {
      void ctx.emit(unixSocketErrorEvent, { error: toError(error, 'eventa: Unix socket message parse error') }, { raw: { message } }).catch(emitError => console.error('Failed to emit Unix socket parse error:', emitError))
    }
  })
  framedSocket.on('error', (error) => {
    const normalized = toError(error, 'eventa: Unix socket error')
    dispose(normalized, false)
    void ctx.emit(unixSocketErrorEvent, { error: normalized }, { raw: { error: normalized } }).catch(emitError => console.error('Failed to emit Unix socket error:', emitError))
  })
  framedSocket.on('close', (hadError: boolean) => {
    dispose(new Error('eventa: invoke cancelled, Unix socket disconnected'), false)
    void ctx.emit(unixSocketDisconnectedEvent, { hadError }, { raw: { hadError } }).catch(emitError => console.error('Failed to emit Unix socket disconnect:', emitError))
  })

  return { context: ctx, dispose }
}

/** Connects to a Unix socket and creates an Eventa context for it. */
export async function connect(path: string, options?: UnixSocketAdapterOptions): Promise<UnixSocketConnection> {
  const socket = createConnection({ path })
  await new Promise<void>((resolve, reject) => {
    let onConnect: () => void
    let onError: (error: Error) => void
    const cleanup = () => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    onConnect = () => {
      cleanup()
      resolve()
    }
    onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
  return createContext(socket, options)
}

/** Listens on a Unix socket and creates one Eventa context for every client. */
export async function createServer(path: string, onConnection: (connection: UnixSocketConnection) => void, options?: UnixSocketAdapterOptions): Promise<UnixSocketServer> {
  const connections = new Set<UnixSocketConnection>()
  const server = createNetServer((socket) => {
    const connection = createContext(socket, options)
    connections.add(connection)
    socket.once('close', () => connections.delete(connection))
    try {
      onConnection(connection)
    }
    catch (error) {
      connection.dispose(error)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    close: async () => {
      for (const connection of connections)
        connection.dispose()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}
