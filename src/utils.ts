export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Checks if a value is an AsyncIterable.
 *
 * @param value
 * @returns True if the value is an AsyncIterable.
 */
export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
}

/**
 * Checks if an object is a ReadableStream.
 *
 * @link https://github.com/cloudflare/workerd/blob/88e8696ce7a5f8969a7e02a2dcfb6504c17c9e8d/src/cloudflare/internal/streaming-forms.ts#L3
 * @param obj
 * @returns True if the object looks like a ReadableStream.
 */
export function isReadableStream<T>(obj?: unknown | null): obj is ReadableStream<T> {
  return !!(
    obj
    && typeof obj === 'object'
    && 'getReader' in obj
    && typeof obj.getReader === 'function'
  )
}

export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }

  if (typeof DOMException !== 'undefined') {
    try {
      return new DOMException(reason ? String(reason) : 'Aborted', 'AbortError')
    }
    catch {
      // fall through
    }
  }

  const error = reason instanceof Error ? reason : new Error(reason ? String(reason) : 'Aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

export function createUntilTriggeredOnce<F extends (...args: any[]) => any, P extends any[] = Parameters<F>, R = ReturnType<F>>(fn: F): {
  onceTriggered: Promise<Awaited<R>>
  wrapper: (...args: P) => Promise<Awaited<R>>
} {
  let resolve!: (r: Awaited<R>) => void
  const promise = new Promise<Awaited<R>>((res) => {
    resolve = res
  })

  const handler = async (...args: P[]): Promise<Awaited<R>> => {
    const res = await fn(...args)
    resolve(res)
    return res
  }

  return {
    onceTriggered: promise,
    wrapper: handler,
  }
}

export function createUntilTriggered<P, R>(fn: (...args: P[]) => R): {
  promise: Promise<void>
  handler: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })

  const handler = (...args: P[]): R => {
    resolve()
    return fn(...args)
  }

  return { promise, handler }
}

export function createUntil<T>(options?: { intervalHandler?: () => Promise<boolean>, interval?: number }): {
  promise: Promise<T>
  handler: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })

  if (options?.intervalHandler) {
    setInterval(() => {
      options?.intervalHandler?.().then((shouldResolve) => {
        if (shouldResolve) {
          resolve(undefined as unknown as T)
        }
      })
    }, options.interval ?? 50)
  }

  return { promise, handler: resolve }
}
