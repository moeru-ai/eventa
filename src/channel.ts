import type { EventContext } from './context'
import type { Eventa } from './eventa'
import type { EventaInner } from './internal'

import { matchBy } from './eventa'
import { getEventaInner, getPreviousContext, setEventaInner } from './internal'

export type ChannelPluginResult
  = | false
    | void
    | Eventa<unknown>
    | Promise<false | void | Eventa<unknown>>

export interface ChannelPluginContext<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
> {
  source: EventContext<FromExtensions, FromEmitOptions>
  target: EventContext<ToExtensions, ToEmitOptions>
  direction?: string
  inner: Readonly<EventaInner>
}

export type ChannelPlugin<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
> = (
  event: Eventa<unknown>,
  context: ChannelPluginContext<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>,
) => ChannelPluginResult

export interface ChannelLinkPluginContext<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> {
  source:
    | EventContext<LeftExtensions, LeftEmitOptions>
    | EventContext<RightExtensions, RightEmitOptions>
  target:
    | EventContext<LeftExtensions, LeftEmitOptions>
    | EventContext<RightExtensions, RightEmitOptions>
  direction?: string
  inner: Readonly<EventaInner>
}

export type ChannelLinkPlugin<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> = (
  event: Eventa<unknown>,
  context: ChannelLinkPluginContext<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>,
) => ChannelPluginResult

export function defineChannelPlugin<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
>(plugin: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>): ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> {
  return plugin
}

export interface ChannelPipe<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
> {
  use: (plugin: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>) => () => void
  dispose: () => void
}

export interface ChannelPipeGroup<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
> extends ChannelPipe<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> {
  pipes: Array<ChannelPipe<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
}

interface ChannelContext {
  emit: <Payload>(event: Eventa<Payload>, payload: Payload, options?: never) => Promise<void>
  on: <Payload>(event: Eventa<Payload>, handler: (payload: Eventa<Payload>) => unknown) => () => void
  signal: AbortSignal
  abort: (reason?: unknown) => void
}
type RuntimeEventContext = EventContext<unknown, unknown>
type ContextExtensionsOf<Context> = Context extends EventContext<infer Extensions, infer _EmitOptions> ? Extensions : never
type ContextEmitOptionsOf<Context> = Context extends EventContext<infer _Extensions, infer EmitOptions> ? EmitOptions : never
type PipeFor<From extends ChannelContext, To extends ChannelContext> = ChannelPipe<
  ContextExtensionsOf<From>,
  ContextEmitOptionsOf<From>,
  ContextExtensionsOf<To>,
  ContextEmitOptionsOf<To>
>

/** Directed pipes for each adjacent pair in a context tuple, in chain order. */
export type ChannelPipes<Contexts extends readonly ChannelContext[]>
  = Contexts extends readonly [infer From extends ChannelContext, infer To extends ChannelContext, ...infer Rest extends ChannelContext[]]
    ? [PipeFor<From, To>, ...ChannelPipes<[To, ...Rest]>]
    : []

/** Runtime edge observed by a plugin shared across an ordered context chain. */
export interface ChannelChainPluginContext<Contexts extends readonly ChannelContext[]> {
  source: Contexts[number]
  target: Contexts[number]
  direction?: string
  inner: Readonly<EventaInner>
}

/** Plugin applied to every directed edge created for an ordered context chain. */
export type ChannelChainPlugin<Contexts extends readonly ChannelContext[]> = (
  event: Eventa<unknown>,
  context: ChannelChainPluginContext<Contexts>,
) => ChannelPluginResult

/** Options shared by every adjacent directed edge in a pipe chain. */
export interface ChannelChainOptions<Contexts extends readonly ChannelContext[]> {
  plugins?: ChannelChainPlugin<Contexts> | Array<ChannelChainPlugin<Contexts>>
  direction?: string
}

/** Options shared by both directions of every adjacent edge in a link chain. */
export interface ChannelLinkChainOptions<Contexts extends readonly ChannelContext[]> {
  plugins?: ChannelChainPlugin<Contexts> | Array<ChannelChainPlugin<Contexts>>
}

/** Handle for an ordered `a -> b -> c` pipe chain. */
export interface ChannelPipeChain<Contexts extends readonly ChannelContext[]> {
  /** One pipe per adjacent pair, ordered from the first context to the last. */
  pipes: ChannelPipes<Contexts>
  /** Adds a plugin to every pipe in this chain. */
  use: (plugin: ChannelChainPlugin<Contexts>) => () => void
  /** Removes only this chain's edges; context lifetimes remain independent. */
  dispose: () => void
}

export interface ChannelPipeOptions<
  FromExtensions = unknown,
  FromEmitOptions = unknown,
  ToExtensions = unknown,
  ToEmitOptions = unknown,
> {
  plugins?:
    | ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
  direction?: string
}

export interface ChannelLinkOptions<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> {
  plugins?:
    | ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>
    | Array<ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>>
}

export interface ChannelLink<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> {
  pipes: Array<ChannelPipe<unknown, unknown, unknown, unknown>>
  use: (plugin: ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>) => () => void
  dispose: () => void
}

/** Forward and reverse pipes for each adjacent pair, in pair order. */
export type ChannelLinkPipes<Contexts extends readonly ChannelContext[]>
  = Contexts extends readonly [infer Left extends ChannelContext, infer Right extends ChannelContext, ...infer Rest extends ChannelContext[]]
    ? [PipeFor<Left, Right>, PipeFor<Right, Left>, ...ChannelLinkPipes<[Right, ...Rest]>]
    : []

/** Handle for an ordered `a <-> b <-> c` bidirectional link chain. */
export interface ChannelLinkChain<Contexts extends readonly ChannelContext[]> {
  /** Two pipes per adjacent pair: forward first, then reverse. */
  pipes: ChannelLinkPipes<Contexts>
  /** Adds a plugin to both directions of every link in this chain. */
  use: (plugin: ChannelChainPlugin<Contexts>) => () => void
  /** Removes only this chain's edges; context lifetimes remain independent. */
  dispose: () => void
}

export type ChannelConnectionOptions<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> = ChannelLinkOptions<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

export type ChannelConnection<
  LeftExtensions = unknown,
  LeftEmitOptions = unknown,
  RightExtensions = unknown,
  RightEmitOptions = unknown,
> = ChannelLink<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

function isEventContext(value: unknown): value is RuntimeEventContext {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<RuntimeEventContext>).emit === 'function'
    && typeof (value as Partial<RuntimeEventContext>).on === 'function'
}

function normalizePlugins<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>(
  plugins?: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>,
): Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>> {
  if (!plugins) {
    return []
  }
  return Array.isArray(plugins) ? [...plugins] : [plugins]
}

function isPipeOptions(value: unknown): value is ChannelPipeOptions {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !isEventContext(value)
}

function parsePipeOptions(value: unknown): ChannelPipeOptions {
  if (typeof value === 'function' || Array.isArray(value)) {
    return { plugins: value as ChannelPlugin | Array<ChannelPlugin> }
  }
  return isPipeOptions(value) ? value : {}
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function'
}

function applyPlugins(
  inner: EventaInner,
  plugins: ChannelPlugin[],
  source: RuntimeEventContext,
  target: RuntimeEventContext,
  direction?: string,
): EventaInner | undefined | Promise<EventaInner | undefined> {
  const context = { source, target, direction }

  function runPlugin(index: number, event: Eventa<unknown>): EventaInner | undefined | Promise<EventaInner | undefined> {
    if (index >= plugins.length) {
      return event === inner.eventa ? inner : { ...inner, eventa: event }
    }

    const currentInner = event === inner.eventa ? inner : { ...inner, eventa: event }
    const result = plugins[index](event, { ...context, inner: currentInner })
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((resolved) => {
        if (resolved === false) {
          return undefined
        }
        return runPlugin(index + 1, typeof resolved === 'undefined' ? event : resolved)
      })
    }
    if (result === false) {
      return undefined
    }
    return runPlugin(index + 1, typeof result === 'undefined' ? event : result)
  }

  return runPlugin(0, inner.eventa)
}

function forwardInner(
  inner: EventaInner,
  plugins: ChannelPlugin[],
  source: RuntimeEventContext,
  target: RuntimeEventContext,
  direction?: string,
): void | Promise<void> {
  const transformed = applyPlugins(inner, plugins, source, target, direction)
  const emit = (result: EventaInner | undefined) => {
    if (!result) {
      return undefined
    }
    const eventa = { ...result.eventa } as Eventa<unknown> & { _flowDirection?: unknown }
    delete eventa._flowDirection
    setEventaInner(eventa, { ...result, eventa }, source)
    return target.emit(eventa, eventa.body, undefined)
  }
  if (isPromiseLike(transformed)) {
    return Promise.resolve(transformed).then(emit)
  }
  return emit(transformed)
}

function createDirectedPipe(
  source: RuntimeEventContext,
  target: RuntimeEventContext,
  sharedPlugins: ChannelPlugin[],
  direction?: string,
): ChannelPipe {
  const localPlugins: ChannelPlugin[] = []
  const off = source.on(matchBy('*'), (event) => {
    const inner = getEventaInner(event)
    // Context omits forwarding state after the hop budget is exhausted.
    if (!inner) {
      return
    }
    // The opposite pipe already delivered this occurrence from `target`.
    // Longer cycles and converging paths are suppressed by Context delivery IDs.
    if (getPreviousContext(event) === target) {
      return
    }
    return forwardInner(inner, [...sharedPlugins, ...localPlugins], source, target, direction)
  })
  let disposed = false

  return {
    use(plugin) {
      if (disposed) {
        throw new Error('Channel pipe disposed.')
      }
      localPlugins.push(plugin)
      return () => {
        const index = localPlugins.indexOf(plugin)
        if (index >= 0) {
          localPlugins.splice(index, 1)
        }
      }
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      off()
      localPlugins.length = 0
    },
  }
}

function createLinkedPair(
  left: RuntimeEventContext,
  right: RuntimeEventContext,
  sharedPlugins: ChannelPlugin[],
  leftIndex: number,
): [ChannelPipe, ChannelPipe] {
  return [
    createDirectedPipe(left, right, sharedPlugins, getLinkDirection(leftIndex, leftIndex + 1)),
    createDirectedPipe(right, left, sharedPlugins, getLinkDirection(leftIndex + 1, leftIndex)),
  ]
}

function getLinkDirection(sourceIndex: number, targetIndex: number): string {
  if (sourceIndex === 0 && targetIndex === 1) {
    return 'left-to-right'
  }
  if (sourceIndex === 1 && targetIndex === 0) {
    return 'right-to-left'
  }
  return `context-${sourceIndex}-to-${targetIndex}`
}

function createGroup(pipes: ChannelPipe[], sharedPlugins: ChannelPlugin[]): ChannelPipeGroup {
  let disposed = false
  return {
    pipes,
    use(plugin) {
      if (disposed) {
        throw new Error('Channel pipe disposed.')
      }
      sharedPlugins.push(plugin)
      return () => {
        const index = sharedPlugins.indexOf(plugin)
        if (index >= 0) {
          sharedPlugins.splice(index, 1)
        }
      }
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      for (const pipe of pipes) {
        pipe.dispose()
      }
      sharedPlugins.length = 0
    },
  }
}

export function pipeChannel<
  FromExtensions = undefined,
  FromEmitOptions = undefined,
  ToExtensions = undefined,
  ToEmitOptions = undefined,
>(
  from: EventContext<FromExtensions, FromEmitOptions>,
  to: EventContext<ToExtensions, ToEmitOptions>,
  options?: ChannelPipeOptions<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> | ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>,
): ChannelPipeGroup<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>

export function pipeChannel<const Contexts extends readonly [ChannelContext, ChannelContext, ChannelContext, ...ChannelContext[]]>(
  ...contextsAndOptions:
    | [...Contexts]
    | [...Contexts, ChannelChainOptions<Contexts> | ChannelChainPlugin<Contexts> | Array<ChannelChainPlugin<Contexts>>]
): ChannelPipeChain<Contexts>

export function pipeChannel<Extensions, EmitOptions>(
  from: EventContext<Extensions, EmitOptions>,
  firstTo: EventContext<Extensions, EmitOptions>,
  ...contextsAndOptions: Array<
    | EventContext<Extensions, EmitOptions>
    | ChannelPipeOptions<Extensions, EmitOptions, Extensions, EmitOptions>
    | ChannelPlugin<Extensions, EmitOptions, Extensions, EmitOptions>
    | Array<ChannelPlugin<Extensions, EmitOptions, Extensions, EmitOptions>>
    | undefined
  >
): ChannelPipeGroup<Extensions, EmitOptions, Extensions, EmitOptions>

export function pipeChannel(
  ...args: unknown[]
): unknown {
  const [from, firstTo, ...contextsAndOptions] = args as [
    RuntimeEventContext,
    RuntimeEventContext,
    ...Array<RuntimeEventContext | ChannelPipeOptions | ChannelPlugin | ChannelPlugin[] | undefined>,
  ]
  const contexts = [from, firstTo]
  let options: ChannelPipeOptions = {}

  for (const item of contextsAndOptions) {
    if (isEventContext(item)) {
      contexts.push(item)
    }
    else if (typeof item !== 'undefined') {
      options = parsePipeOptions(item)
    }
  }

  const sharedPlugins = normalizePlugins(options.plugins)
  const pipes = contexts.slice(0, -1).map((source, index) => createDirectedPipe(
    source,
    contexts[index + 1],
    sharedPlugins,
    options.direction,
  ))
  return createGroup(pipes, sharedPlugins)
}

export function linkChannel<
  LeftExtensions = undefined,
  LeftEmitOptions = undefined,
  RightExtensions = undefined,
  RightEmitOptions = undefined,
>(
  left: EventContext<LeftExtensions, LeftEmitOptions>,
  right: EventContext<RightExtensions, RightEmitOptions>,
  options?: ChannelLinkOptions<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>,
): ChannelLink<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

export function linkChannel<const Contexts extends readonly [ChannelContext, ChannelContext, ChannelContext, ...ChannelContext[]]>(
  ...contextsAndOptions:
    | [...Contexts]
    | [...Contexts, ChannelLinkChainOptions<Contexts>]
): ChannelLinkChain<Contexts>

export function linkChannel<Extensions, EmitOptions>(
  ...contextsAndOptions: Array<
    | EventContext<Extensions, EmitOptions>
    | ChannelLinkOptions<Extensions, EmitOptions, Extensions, EmitOptions>
    | undefined
  >
): ChannelLink<Extensions, EmitOptions, Extensions, EmitOptions>

export function linkChannel(
  ...args: unknown[]
): unknown {
  const contextsAndOptions = args as Array<RuntimeEventContext | ChannelLinkOptions | undefined>
  const contexts: RuntimeEventContext[] = []
  let options: ChannelLinkOptions = {}

  for (const item of contextsAndOptions) {
    if (isEventContext(item)) {
      contexts.push(item)
    }
    else if (item) {
      options = item
    }
  }

  const sharedPlugins = normalizePlugins(options.plugins)
  const pipes: ChannelPipe[] = []
  for (let index = 0; index < contexts.length - 1; index += 1) {
    const [forward, backward] = createLinkedPair(contexts[index], contexts[index + 1], sharedPlugins, index)
    pipes.push(forward, backward)
  }

  return createGroup(pipes, sharedPlugins)
}
