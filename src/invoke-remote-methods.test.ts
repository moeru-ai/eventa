import type { InvocableEventContext } from './invoke'

import { describe, expect, it, vi } from 'vitest'

import { createContext } from './context'
import { createRemoteMethodTagPrefix, withRemoteMethods } from './invoke-remote-methods'
import { defineInvokeEventa } from './invoke-shared'

describe('invoke-remote-methods', () => {
  it('should support function stubs in invoke payloads', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<{ output: number }, { helper: (value: number) => Promise<number> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, async ({ helper }) => {
        const output = await helper(21)
        return { output }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const helper = vi.fn(async (value: number) => value * 2)

    const result = await invoke({ helper }, { functionStubs: true })
    expect(result).toEqual({ output: 42 })
    expect(helper).toHaveBeenCalledTimes(1)
    expect(helper).toHaveBeenCalledWith(21, expect.objectContaining({
      abortController: expect.any(AbortController),
    }))
  })

  it('should expose dispose on invoke result', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<string, { helper: () => string }>()

    withRemoteMethods({ allow: true }).defineInvokeHandler(ctx, events, ({ helper }) => helper())
    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const result = invoke({ helper: () => 'ok' }, { functionStubs: true })

    expect(typeof result.dispose).toBe('function')
    result.dispose()

    await expect(result).resolves.toBe('ok')
  })

  it('should reject when function stubs exceed maxFunctions', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<string, { a: () => void, b: () => void }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, () => 'ok')
    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)

    await expect(invoke(
      { a: () => void 0, b: () => void 0 },
      { functionStubs: { maxFunctions: 1 } },
    )).rejects.toThrowError('Too many function stubs in invoke payload')
  })

  it('should ignore disallowed function stub tags when configured', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { helper: unknown }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ helper }) => {
        const isFunction = typeof helper === 'function'
        return { ok: !isFunction }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const payload = { helper: { __eventaInvoke: { tag: 'not-allowed' } } }

    const result = await invoke(payload, { functionStubs: { onDisallowedTag: 'ignore', tagPrefix: 'eventa-invoke-fn-' } })
    expect(result).toEqual({ ok: true })
  })

  it('should avoid prototype pollution when function stubs are enabled', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L108-L117
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const polluted = (options as any).test === 'value'
        return {
          ok: proto === null && !polluted,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"__proto__":{"test":"value"}}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should avoid constructor.prototype pollution when function stubs are enabled', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L71-L83
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const pollutedLocal = (options as any).polluted === 'yes'
        const pollutedGlobal = ({} as any).polluted === 'yes'
        return {
          ok: proto === null && !pollutedLocal && !pollutedGlobal,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should auto-dispose stub handlers after timeout', async () => {
    const ctx = createContext() as InvocableEventContext<any, any>
    const events = defineInvokeEventa<string, { helper: () => string }>()
    const tagPrefix = createRemoteMethodTagPrefix('test-remote-methods-')

    withRemoteMethods({ allow: true, autoDisposeMs: 5, tagPrefix })
      .defineInvokeHandler(ctx, events, ({ helper }) => helper())
    const invoke = withRemoteMethods({ allow: true, autoDisposeMs: 5, tagPrefix }).defineInvoke(ctx, events)

    const result = invoke({ helper: () => 'ok' }, { functionStubs: true })
    await expect(result).resolves.toBe('ok')

    await new Promise(resolve => setTimeout(resolve, 10))
    const stubListenerEntries = [...(ctx.listeners?.entries?.() ?? [])]
      .filter(([key]) => key.startsWith(tagPrefix))
    const hasActiveListeners = stubListenerEntries.some(([, handlers]) => handlers.size > 0)
    expect(hasActiveListeners).toBe(false)
  })

  it('should reject malformed stubs in strict mode', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { helper: unknown }>()

    withRemoteMethods({ allow: true, strict: true })
      .defineInvokeHandler(ctx, events, () => ({ ok: true }))
    const invoke = withRemoteMethods({ allow: true, strict: true }).defineInvoke(ctx, events)

    const payload = { helper: { __eventaInvoke: 'not-an-object' } }
    await expect(invoke(payload, { functionStubs: true })).rejects.toThrowError('Invalid invoke function stub payload.')
  })

  it('should avoid nested __proto__ pollution', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L71-L77
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const pollutedLocal = (options as any).polluted === 'yes'
        const pollutedNested = (options as any)?.nested?.polluted === 'yes'
        const pollutedGlobal = ({} as any).polluted === 'yes'
        return {
          ok: proto === null && !pollutedLocal && !pollutedNested && !pollutedGlobal,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"nested":{"__proto__":{"polluted":"yes"}}}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should ignore prototype key pollution attempts', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L79-L83
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const polluted = (options as any).polluted === 'yes'
        const pollutedGlobal = ({} as any).polluted === 'yes'
        return {
          ok: proto === null && !polluted && !pollutedGlobal,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"prototype":{"polluted":"yes"}}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should handle __defineGetter__ and __defineSetter__ keys safely', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L71-L75
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const hasGetter = Object.prototype.hasOwnProperty.call(options, '__defineGetter__')
        const hasSetter = Object.prototype.hasOwnProperty.call(options, '__defineSetter__')
        return {
          ok: proto === null && hasGetter && hasSetter,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"__defineGetter__": "noop", "__defineSetter__": "noop"}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should not rely on prototype lookups for toString/valueOf', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L12-L14
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const hasToString = Object.prototype.hasOwnProperty.call(options, 'toString')
        const hasValueOf = Object.prototype.hasOwnProperty.call(options, 'valueOf')
        return {
          ok: proto === null && hasToString && hasValueOf,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"toString":"x","valueOf":"y"}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should avoid array-based __proto__ pollution', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L71-L77
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: unknown[] }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const pollutedGlobal = ({} as any).polluted === 'yes'
        const pollutedArray = (options as any).polluted === 'yes'
        return {
          ok: !pollutedGlobal && !pollutedArray,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('[{"__proto__":{"polluted":"yes"}}]') as unknown[]

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })

  it('should avoid multi-depth constructor.prototype pollution', async () => {
    // MDN: https://github.com/mdn/content/blob/d67650e38cd150ce190e5116355fcb362eb759bd/files/en-us/web/security/attacks/prototype_pollution/index.md?plain=1#L79-L83
    const ctx = createContext()
    const events = defineInvokeEventa<{ ok: boolean }, { options: Record<string, unknown> }>()

    withRemoteMethods({ allow: true })
      .defineInvokeHandler(ctx, events, ({ options }) => {
        const proto = Object.getPrototypeOf(options)
        const pollutedLocal = (options as any).polluted === 'yes'
        const pollutedNested = (options as any)?.deep?.polluted === 'yes'
        const pollutedGlobal = ({} as any).polluted === 'yes'
        return {
          ok: proto === null && !pollutedLocal && !pollutedNested && !pollutedGlobal,
        }
      })

    const invoke = withRemoteMethods({ allow: true }).defineInvoke(ctx, events)
    const options = JSON.parse('{"deep":{"constructor":{"prototype":{"polluted":"yes"}}}}') as Record<string, unknown>

    const result = await invoke({ options }, { functionStubs: true })
    expect(result).toEqual({ ok: true })
  })
})
