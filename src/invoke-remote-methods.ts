import type { EventContext } from './context'
import type { ExtractInvokeRequestOptions, Handler, InvocableEventContext } from './invoke'
import type { InvokeEventa } from './invoke-shared'

import { nanoid } from './eventa'
import { defineInvoke, defineInvokeHandler } from './invoke'
import { defineInvokeEventa } from './invoke-shared'

export interface InvokeFunctionStubOptions {
  allow?: boolean
  maxDepth?: number
  maxFunctions?: number
  tagPrefix?: string
  onDisallowedTag?: 'ignore' | 'throw'
  autoDisposeMs?: number
  strict?: boolean
}

export type RemoteInvokeOptions<EC extends EventContext<any, any>> = ExtractInvokeRequestOptions<EC> & {
  functionStubs?: boolean | InvokeFunctionStubOptions
}

export interface RemoteInvokeResult<Res> extends Promise<Res> {
  dispose: () => void
}

export type RemoteInvokeFunction<Res, Req, EC extends EventContext<any, any>>
  = [Req] extends [undefined]
    ? (req?: Req, options?: RemoteInvokeOptions<EC>) => RemoteInvokeResult<Res>
    : (req: Req, options?: RemoteInvokeOptions<EC>) => RemoteInvokeResult<Res>

const DEFAULT_FUNCTION_STUB_OPTIONS: Required<Pick<InvokeFunctionStubOptions, 'maxDepth' | 'maxFunctions' | 'tagPrefix' | 'onDisallowedTag' | 'autoDisposeMs' | 'strict'>> = {
  maxDepth: 32,
  maxFunctions: 32,
  tagPrefix: 'eventa-invoke-fn-',
  onDisallowedTag: 'ignore',
  autoDisposeMs: 0,
  strict: false,
}

export function createRemoteMethodTagPrefix(prefix = DEFAULT_FUNCTION_STUB_OPTIONS.tagPrefix) {
  return `${prefix}${nanoid()}-`
}

function normalizeFunctionStubOptions(options?: boolean | InvokeFunctionStubOptions) {
  if (options === true) {
    return {
      allow: true,
      ...DEFAULT_FUNCTION_STUB_OPTIONS,
    }
  }
  if (!options) {
    return {
      allow: false,
      ...DEFAULT_FUNCTION_STUB_OPTIONS,
    }
  }

  return {
    allow: options.allow ?? true,
    maxDepth: options.maxDepth ?? DEFAULT_FUNCTION_STUB_OPTIONS.maxDepth,
    maxFunctions: options.maxFunctions ?? DEFAULT_FUNCTION_STUB_OPTIONS.maxFunctions,
    tagPrefix: options.tagPrefix ?? DEFAULT_FUNCTION_STUB_OPTIONS.tagPrefix,
    onDisallowedTag: options.onDisallowedTag ?? DEFAULT_FUNCTION_STUB_OPTIONS.onDisallowedTag,
    autoDisposeMs: options.autoDisposeMs ?? DEFAULT_FUNCTION_STUB_OPTIONS.autoDisposeMs,
    strict: options.strict ?? DEFAULT_FUNCTION_STUB_OPTIONS.strict,
  }
}

function resolveFunctionStubOptions(
  defaults?: boolean | InvokeFunctionStubOptions,
  override?: boolean | InvokeFunctionStubOptions,
) {
  const base = normalizeFunctionStubOptions(defaults)

  if (typeof override === 'undefined') {
    return base
  }
  if (typeof override === 'boolean') {
    return {
      ...base,
      allow: override,
    }
  }

  return {
    ...base,
    ...normalizeFunctionStubOptions(override),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

interface InvokeFunctionStubPayload {
  __eventaInvoke?: {
    tag: string
  }
}

function isInvokeFunctionStubPayload(value: unknown): value is InvokeFunctionStubPayload {
  if (!isPlainObject(value)) {
    return false
  }
  if (!('__eventaInvoke' in value)) {
    return false
  }

  const stub = (value as InvokeFunctionStubPayload).__eventaInvoke
  return !!stub && typeof stub === 'object' && typeof stub.tag === 'string'
}

function hasInvokeFunctionStubKey(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && '__eventaInvoke' in value
}

function serializeInvokeFunctionPayload<T>(
  value: T,
  ctx: InvocableEventContext<any, any>,
  options: ReturnType<typeof normalizeFunctionStubOptions>,
) {
  if (!options.allow) {
    return { value, dispose: () => void 0 }
  }

  let functionCount = 0
  const seen = new WeakMap<object, any>()
  const disposers: Array<() => void> = []

  const walk = (input: any, depth: number): any => {
    if (typeof input === 'function') {
      if (functionCount >= options.maxFunctions) {
        throw new Error(`Too many function stubs in invoke payload (max ${options.maxFunctions}).`)
      }

      functionCount += 1
      const tag = `${options.tagPrefix}${nanoid()}`
      const event = defineInvokeEventa<any, any>(tag)
      const off = defineInvokeHandler(ctx, event, (payload, handlerOptions) => {
        return input(payload, handlerOptions)
      })
      disposers.push(off)

      return { __eventaInvoke: { tag } }
    }

    if (input == null || typeof input !== 'object') {
      return input
    }

    if (depth > options.maxDepth) {
      throw new Error(`Invoke payload is too deep (max ${options.maxDepth}).`)
    }

    if (seen.has(input)) {
      return seen.get(input)
    }

    if (Array.isArray(input)) {
      const output: any[] = Array.from({ length: input.length })
      seen.set(input, output)
      for (let i = 0; i < input.length; i += 1) {
        output[i] = walk(input[i], depth + 1)
      }
      return output
    }

    if (!isPlainObject(input)) {
      return input
    }

    // Use null-prototype object to mitigate prototype pollution attacks
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object#null-prototype_objects
    // https://github.com/OWASP/CheatSheetSeries/blob/38a2e501d345c710207b492a50f46e0f368578fe/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.md
    // https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html#other-resources
    const output: Record<string, any> = Object.create(null)
    seen.set(input, output)
    for (const [key, child] of Object.entries(input)) {
      output[key] = walk(child, depth + 1)
    }
    return output
  }

  return {
    value: walk(value, 0) as T,
    dispose: () => {
      for (const off of disposers) {
        off()
      }
    },
  }
}

function deserializeInvokeFunctionPayload<T>(
  value: T,
  ctx: EventContext<any, any>,
  options: ReturnType<typeof normalizeFunctionStubOptions>,
) {
  if (!options.allow) {
    return value
  }

  let functionCount = 0
  const seen = new WeakMap<object, any>()

  const walk = (input: any, depth: number): any => {
    if (input == null || typeof input !== 'object') {
      return input
    }

    if (depth > options.maxDepth) {
      throw new Error(`Invoke payload is too deep (max ${options.maxDepth}).`)
    }

    if (isInvokeFunctionStubPayload(input)) {
      if (functionCount >= options.maxFunctions) {
        throw new Error(`Too many function stubs in invoke payload (max ${options.maxFunctions}).`)
      }

      const tag = input.__eventaInvoke!.tag
      if (options.tagPrefix && !tag.startsWith(options.tagPrefix)) {
        if (options.onDisallowedTag === 'throw') {
          throw new Error(`Invoke function tag not allowed: ${tag}`)
        }

        return input
      }

      functionCount += 1
      const event = defineInvokeEventa<any, any>(tag)

      return defineInvoke(ctx as EventContext<any, any>, event)
    }
    else if (options.strict && hasInvokeFunctionStubKey(input)) {
      throw new Error('Invalid invoke function stub payload.')
    }

    if (seen.has(input)) {
      return seen.get(input)
    }

    if (Array.isArray(input)) {
      const output: any[] = Array.from({ length: input.length })
      seen.set(input, output)
      for (let i = 0; i < input.length; i += 1) {
        output[i] = walk(input[i], depth + 1)
      }
      return output
    }

    if (!isPlainObject(input)) {
      return input
    }

    // Use null-prototype object to mitigate prototype pollution attacks
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object#null-prototype_objects
    // https://github.com/OWASP/CheatSheetSeries/blob/38a2e501d345c710207b492a50f46e0f368578fe/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.md
    // https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html#other-resources
    const output: Record<string, any> = Object.create(null)
    seen.set(input, output)
    for (const [key, child] of Object.entries(input)) {
      output[key] = walk(child, depth + 1)
    }

    return output
  }

  return walk(value, 0) as T
}

/**
 * Enable "remote method" payloads for invoke: functions in the request body are
 * serialized into stub descriptors and rehydrated into invoke callers on the
 * receiving side.
 *
 * This is an adapter around the plain-value RPC primitives `defineInvoke` and
 * `defineInvokeHandler`. It keeps the core invoke APIs clean while offering an
 * opt-in bridge for function values.
 *
 * @example
 * ```ts
 * const remote = withRemoteMethods({ allow: true })
 * const events = defineInvokeEventa<{ output: number }, { helper: (n: number) => Promise<number> }>()
 *
 * // server (handler)
 * remote.defineInvokeHandler(serverCtx, events, async ({ helper }) => {
 *   const output = await helper(21)
 *   return { output }
 * })
 *
 * // client (caller)
 * const invoke = remote.defineInvoke(clientCtx, events)
 * const result = await invoke({ helper: async n => n * 2 }, { functionStubs: true })
 * ```
 *
 * @example
 * ```ts
 * // Manual cleanup when you fire-and-forget or cancel midway:
 * const invoke = remote.defineInvoke(clientCtx, events)
 * const result = invoke({ helper: () => 'ok' }, { functionStubs: true })
 * result.dispose()
 * await result
 * ```
 *
 * Security notes:
 * - This feature is off by default. Enabling it allows the remote side to call
 *   back into your process; only use with trusted peers.
 * - Function stubs are tagged; prefer a unique `tagPrefix` to avoid collisions
 *   (see `createRemoteMethodTagPrefix`).
 * - `maxDepth`, `maxFunctions`, and `autoDisposeMs` limit attack surface and
 *   resource usage. `autoDisposeMs` is useful for fire-and-forget calls.
 * - Objects are rebuilt with a null prototype to mitigate `__proto__` pollution.
 * - Enable `strict` to reject malformed `__eventaInvoke` payloads.
 *
 * @param defaultOptions Defaults for function stub behavior. Use `{ allow: true }`
 *        to enable, or provide `maxDepth`, `maxFunctions`, `tagPrefix`,
 *        `onDisallowedTag`, `autoDisposeMs`, and `strict` for stricter control.
 */
export function withRemoteMethods(defaultOptions?: boolean | InvokeFunctionStubOptions) {
  return {
    defineInvoke<
      Res,
      Req = undefined,
      ResErr = Error,
      ReqErr = Error,
      CtxExt = any,
      EOpts = any,
      ECtx extends EventContext<CtxExt, EOpts> = EventContext<CtxExt, EOpts>,
    >(ctx: ECtx,
      event: InvokeEventa<Res, Req, ResErr, ReqErr>,
    ): RemoteInvokeFunction<Res, Req, ECtx> {
      const baseInvoke = defineInvoke(ctx, event)

      const invoke = ((req?: Req, options?: RemoteInvokeOptions<ECtx>) => {
        const { functionStubs, ...invokeOptions } = (options ?? {}) as RemoteInvokeOptions<ECtx> & Record<string, any>
        const normalizedOptions = resolveFunctionStubOptions(defaultOptions, functionStubs)

        if (!normalizedOptions.allow) {
          const promise = baseInvoke(req as Req, invokeOptions as ExtractInvokeRequestOptions<ECtx>)
          const wrapped = promise as RemoteInvokeResult<Res>
          wrapped.dispose = () => void 0

          return wrapped
        }

        let serialized: ReturnType<typeof serializeInvokeFunctionPayload<Req>>
        try {
          serialized = serializeInvokeFunctionPayload(req as Req, ctx as InvocableEventContext<any, any>, normalizedOptions)
        }
        catch (error) {
          const rejected = Promise.reject(error) as RemoteInvokeResult<Res>
          rejected.dispose = () => void 0

          return rejected
        }

        let disposed = false
        const dispose = () => {
          if (disposed) {
            return
          }

          disposed = true
          serialized.dispose()
        }

        let autoDisposeTimer: ReturnType<typeof setTimeout> | undefined
        if (normalizedOptions.autoDisposeMs > 0) {
          autoDisposeTimer = setTimeout(() => {
            dispose()
          }, normalizedOptions.autoDisposeMs)
        }

        const finalize = () => {
          if (autoDisposeTimer) {
            clearTimeout(autoDisposeTimer)
          }
          dispose()
        }

        const promise = baseInvoke(serialized.value as Req, invokeOptions as ExtractInvokeRequestOptions<ECtx>)
          .finally(finalize)

        const wrapped = promise as RemoteInvokeResult<Res>
        wrapped.dispose = finalize

        return wrapped
      }) as RemoteInvokeFunction<Res, Req, ECtx>

      return invoke
    },

    defineInvokeHandler<
      Res,
      Req = undefined,
      ResErr = Error,
      ReqErr = Error,
      CtxExt = any,
      EOpts extends { raw?: any } = any,
    >(
      ctx: InvocableEventContext<CtxExt, EOpts>,
      event: InvokeEventa<Res, Req, ResErr, ReqErr>,
      handler: Handler<Res, Req, InvocableEventContext<CtxExt, EOpts>, EOpts>,
    ) {
      const normalizedOptions = resolveFunctionStubOptions(defaultOptions)

      return defineInvokeHandler(ctx, event, async (payload, options) => {
        const handlerPayload = normalizedOptions.allow
          ? deserializeInvokeFunctionPayload(payload as Req, ctx, normalizedOptions)
          : payload

        return handler(handlerPayload as Req, options)
      })
    },
  }
}
