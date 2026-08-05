import type { WSMessageReceive } from 'hono/ws'

/**
 * Reads a Hono WebSocket payload as text.
 *
 * @example
 * await readMessageText('hello')
 * // => 'hello'
 */
export async function readMessageText(data: WSMessageReceive): Promise<string> {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof Blob) {
    return data.text()
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data)
  }
  throw new TypeError('Unsupported Hono websocket message payload')
}
