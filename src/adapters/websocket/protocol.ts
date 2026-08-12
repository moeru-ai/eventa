/** Application close code used when a peer speaks an unsupported Eventa wire protocol. */
export const WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE = 4002

/** Stable close reason paired with {@link WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE}. */
export const WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON = 'Unsupported Protocol'

/** Returns whether a WebSocket close code identifies an Eventa protocol mismatch. */
export function isUnsupportedProtocolClose(code: number): boolean {
  return code === WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE
}

export interface WebSocketProtocolGuard<TDetails> {
  /** Whether this connection has already rejected an incompatible frame. */
  readonly rejected: boolean
  /** Rejects the first incompatible frame and ignores subsequent frames. */
  reject: (error: unknown, details: TDetails) => boolean
}

/**
 * Owns the terminal protocol-error transition for one WebSocket connection.
 * The first invalid frame is reported and closes the connection; later frames
 * are ignored so an incompatible peer cannot create an error storm.
 */
export function createWebSocketProtocolGuard<TDetails>(options: {
  close: (code: number, reason: string) => void
  onRejected: (error: unknown, details: TDetails) => void
}): WebSocketProtocolGuard<TDetails> {
  let rejected = false

  return {
    get rejected() {
      return rejected
    },
    reject(error, details) {
      if (rejected) {
        return false
      }

      rejected = true
      console.error('Failed to parse WebSocket message:', error)

      try {
        options.onRejected(error, details)
      }
      finally {
        options.close(
          WS_UNSUPPORTED_PROTOCOL_CLOSE_CODE,
          WS_UNSUPPORTED_PROTOCOL_CLOSE_REASON,
        )
      }

      return true
    },
  }
}
