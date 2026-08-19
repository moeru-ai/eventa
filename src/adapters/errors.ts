/**
 * The kind of failure an adapter ran into while bridging messages.
 *
 * - `parse`        — an inbound message could not be parsed/deserialized. The
 *                    transport is still alive; only this one message was lost.
 * - `fatal`        — an unrecoverable transport error (load / syntax / runtime
 *                    `error` event). The context is aborted and in-flight
 *                    invokes reject.
 * - `messageerror` — a message could not be deserialized by the transport
 *                    itself (structured-clone failure). The context is aborted.
 */
export type AdapterErrorKind = 'parse' | 'fatal' | 'messageerror'

/**
 * Normalized payload emitted by every adapter when it encounters an error.
 *
 * `error` is always unwrapped to a real `Error` (with a stack where one is
 * available) so subscribers never have to dig a thrown value out of an
 * `ErrorEvent`. The `kind` discriminator tells callers whether the transport
 * is still usable (`parse`) or has been torn down (`fatal` / `messageerror`).
 *
 * For `messageerror`, `message` carries the original (undeserializable)
 * `MessageEvent`/message so the failed payload isn't silently dropped.
 */
export interface AdapterErrorPayload {
  kind: AdapterErrorKind
  error: Error
  message?: unknown
}

interface ErrorEventLike {
  error?: unknown
  message?: unknown
}

/**
 * Coerce whatever a transport hands us — an `Error`, a browser `ErrorEvent`, a
 * `MessageEvent`, or some host-specific object — into a real `Error`, without
 * losing the original message/stack.
 *
 * `ErrorEvent` is referenced defensively because it does not exist in every
 * runtime that uses these adapters (e.g. Node's worker_threads).
 */
export function toError(input: unknown, fallbackMessage: string): Error {
  if (input instanceof Error) {
    return input
  }

  // Browser ErrorEvent: prefer the actual thrown value, then its message.
  if (typeof ErrorEvent !== 'undefined' && input instanceof ErrorEvent) {
    if (input.error instanceof Error) {
      return input.error
    }
    if (typeof input.message === 'string' && input.message) {
      return new Error(input.message)
    }
  }

  // Any error-event-like object carrying a thrown Error or a message string.
  if (input != null && typeof input === 'object') {
    const candidate = input as ErrorEventLike
    if (candidate.error instanceof Error) {
      return candidate.error
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      return new Error(candidate.message)
    }
  }

  return new Error(fallbackMessage)
}
