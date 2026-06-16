import type { EventContext } from './context'
import type { DirectionalEventa, Eventa } from './eventa'

import { and, defineInboundEventa, EventaFlowDirection, matchBy } from './eventa'

export type ChannelPluginResult
  = | false
    | void
    | Eventa<any>
    | Promise<false | void | Eventa<any>>

export interface ChannelPluginContext<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> {
  source: EventContext<FromExtensions, FromEmitOptions>
  target: EventContext<ToExtensions, ToEmitOptions>
  direction?: string
}

export type ChannelPlugin<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> = (
  event: Eventa<any>,
  context: ChannelPluginContext<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>,
) => ChannelPluginResult

export interface ChannelLinkPluginContext<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> {
  source:
    | EventContext<LeftExtensions, LeftEmitOptions>
    | EventContext<RightExtensions, RightEmitOptions>
  target:
    | EventContext<LeftExtensions, LeftEmitOptions>
    | EventContext<RightExtensions, RightEmitOptions>
  direction?: string
}

export type ChannelLinkPlugin<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> = (
  event: Eventa<any>,
  context: ChannelLinkPluginContext<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>,
) => ChannelPluginResult

export function defineChannelPlugin<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
>(plugin: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>): ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> {
  return plugin
}

export interface ChannelPipe<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> {
  use: (plugin: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>) => () => void
  dispose: () => void
}

export interface ChannelPipeGroup<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> extends ChannelPipe<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> {
  pipes: Array<ChannelPipe<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
}

export interface ChannelPipeOptions<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> {
  plugins?:
    | ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
  direction?: string
  /**
   * Propagates source context abort to every target context by default.
   *
   * NOTICE: this is lifecycle propagation, not an event flowing through the
   * plugin pipeline. Channel plugins and filters do not block it. Set false
   * when contexts should share events but keep independent lifetimes.
   */
  propagateAbort?: boolean
}

export interface ChannelLinkOptions<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> {
  plugins?:
    | ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>
    | Array<ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>>
  /**
   * Propagates abort across the linked mesh by default.
   *
   * NOTICE: this is lifecycle propagation, not an event flowing through the
   * plugin pipeline. Link plugins and filters do not block it. Set false when
   * contexts should share events but keep independent lifetimes.
   */
  propagateAbort?: boolean
}

export interface ChannelLink<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> {
  pipes: Array<ChannelPipe<any, any, any, any>>
  use: (plugin: ChannelLinkPlugin<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>) => () => void
  dispose: () => void
}

// TODO: Add route selectors on top of the group model:
// - pipeChannel(...).to(target).use(plugin) for target-specific fan-out rules.
// - linkChannel(...).from(source).to(target).use(plugin) for one directed edge.
// - linkChannel(...).between(left, right).use(plugin) for both directions.
// Keep those as chainable selectors instead of widening options into a route
// table; route behavior belongs to edges and should compose with group .use().
//
// NOTICE: linkChannel(...contexts) creates a fully-connected bidirectional
// mesh. It is not a linear chain like a <-> b <-> c.

export type ChannelConnectionOptions<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> = ChannelLinkOptions<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

export type ChannelConnection<
  LeftExtensions = any,
  LeftEmitOptions = any,
  RightExtensions = any,
  RightEmitOptions = any,
> = ChannelLink<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

function normalizePlugins<
  FromExtensions,
  FromEmitOptions,
  ToExtensions,
  ToEmitOptions,
>(plugins?: ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>): Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>> {
  if (!plugins) {
    return []
  }

  return Array.isArray(plugins) ? [...plugins] : [plugins]
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === 'function'
}

function toInboundEvent(event: Eventa<any>): Eventa<any> {
  return {
    ...defineInboundEventa(event.id),
    ...event,
    _flowDirection: EventaFlowDirection.Inbound,
  } as Eventa<any>
}

function isEventContext(value: unknown): value is EventContext<any, any> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as EventContext<any, any>).emit === 'function'
    && typeof (value as EventContext<any, any>).on === 'function'
}

function isPipeOptions(value: unknown): value is ChannelPipeOptions<any, any, any, any> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !isEventContext(value)
    && ('plugins' in value || 'direction' in value || 'propagateAbort' in value)
}

interface CreateChannelPipeOptions<
  FromExtensions = any,
  FromEmitOptions = any,
  ToExtensions = any,
  ToEmitOptions = any,
> {
  plugins?: Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
  direction?: string
  propagateAbort?: boolean
}

function createChannelPipe<
  FromExtensions = undefined,
  FromEmitOptions = undefined,
  ToExtensions = undefined,
  ToEmitOptions = undefined,
>(
  from: EventContext<FromExtensions, FromEmitOptions>,
  to: EventContext<ToExtensions, ToEmitOptions>,
  pipeOptions: CreateChannelPipeOptions<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> = {},
): ChannelPipe<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> {
  const plugins = pipeOptions.plugins ?? []
  const localPluginList: Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>> = []

  const onSourceAbort = () => {
    to.abort(from.signal.reason)
  }

  if (pipeOptions.propagateAbort ?? true) {
    if (from.signal.aborted) {
      onSourceAbort()
    }
    else {
      from.signal.addEventListener('abort', onSourceAbort, { once: true })
    }
  }

  const off = from.on(and(
    matchBy((event: DirectionalEventa<any>) => event._flowDirection === EventaFlowDirection.Outbound || !event._flowDirection),
    matchBy('*'),
  ), async (event, options) => {
    let current: Eventa<any> = event
    const context: ChannelPluginContext<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions> = { source: from, target: to, direction: pipeOptions.direction }

    // Keep the two lists separate to avoid copying plugin arrays on every event;
    // shared plugins still run before pipe-local plugins.
    for (const pluginList of [plugins, localPluginList]) {
      for (const plugin of pluginList) {
        const pluginResult = plugin(current, context)
        const result = isPromiseLike(pluginResult)
          ? await pluginResult
          : pluginResult

        if (result === false) {
          return
        }
        if (typeof result !== 'undefined') {
          current = result
        }
      }
    }

    await to.emit(toInboundEvent(current), current.body, options as never)
  })

  let disposed = false

  return {
    use(plugin) {
      if (disposed) {
        throw new Error('Channel pipe disposed.')
      }

      localPluginList.push(plugin)

      return () => {
        const index = localPluginList.indexOf(plugin)

        if (index >= 0) {
          localPluginList.splice(index, 1)
        }
      }
    },

    dispose() {
      if (disposed) {
        return
      }

      disposed = true
      off()
      from.signal.removeEventListener('abort', onSourceAbort)
      localPluginList.length = 0
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
  options?:
    | ChannelPipeOptions<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>,
): ChannelPipeGroup<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>

export function pipeChannel<
  FromExtensions = undefined,
  FromEmitOptions = undefined,
  ToExtensions = undefined,
  ToEmitOptions = undefined,
>(
  from: EventContext<FromExtensions, FromEmitOptions>,
  firstTo: EventContext<ToExtensions, ToEmitOptions>,
  ...targetsAndOptions: Array<
    | EventContext<ToExtensions, ToEmitOptions>
    | ChannelPipeOptions<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>
    | Array<ChannelPlugin<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>>
  >
): ChannelPipeGroup<FromExtensions, FromEmitOptions, ToExtensions, ToEmitOptions>

export function pipeChannel(
  from: EventContext<any, any>,
  firstTo: EventContext<any, any>,
  ...targetsAndOptions: Array<
    | EventContext<any, any>
    | ChannelPipeOptions<any, any, any, any>
    | ChannelPlugin<any, any, any, any>
    | Array<ChannelPlugin<any, any, any, any>>
    | undefined
  >
): ChannelPipeGroup<any, any, any, any> {
  const targets: Array<EventContext<any, any>> = [firstTo]
  let options: ChannelPipeOptions<any, any, any, any> = {}

  for (const item of targetsAndOptions) {
    if (!item) {
      continue
    }

    if (isEventContext(item)) {
      targets.push(item)
      continue
    }

    if (isPipeOptions(item)) {
      options = item
      continue
    }

    options = {
      ...options,
      plugins: item,
    }
  }

  const pluginList = normalizePlugins(options.plugins)
  const pipes = targets.map(target => createChannelPipe(from, target, {
    plugins: pluginList,
    direction: options.direction,
    propagateAbort: options.propagateAbort,
  }))
  let disposed = false

  return {
    pipes,
    use(plugin) {
      if (disposed) {
        throw new Error('Channel pipe disposed.')
      }

      pluginList.push(plugin)

      return () => {
        const index = pluginList.indexOf(plugin)

        if (index >= 0) {
          pluginList.splice(index, 1)
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
      pluginList.length = 0
    },
  }
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

export function linkChannel<
  LeftExtensions = undefined,
  LeftEmitOptions = undefined,
  RightExtensions = undefined,
  RightEmitOptions = undefined,
>(
  leftContext: EventContext<LeftExtensions, LeftEmitOptions>,
  rightContext: EventContext<RightExtensions, RightEmitOptions>,
  options?: ChannelLinkOptions<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>,
): ChannelLink<LeftExtensions, LeftEmitOptions, RightExtensions, RightEmitOptions>

export function linkChannel(
  ...contextsAndOptions: Array<EventContext<any, any> | ChannelLinkOptions<any, any, any, any>>
): ChannelLink<any, any, any, any>

export function linkChannel(
  ...contextsAndOptions: Array<EventContext<any, any> | ChannelLinkOptions<any, any, any, any> | undefined>
): ChannelLink<any, any, any, any> {
  const contexts: Array<EventContext<any, any>> = []
  let options: ChannelLinkOptions<any, any, any, any> = {}

  for (const item of contextsAndOptions) {
    if (!item) {
      continue
    }

    if (isEventContext(item)) {
      contexts.push(item)
      continue
    }

    options = item
  }

  const pluginList = normalizePlugins(options.plugins) as Array<ChannelPlugin<any, any, any, any>>
  const pipes: Array<ChannelPipe<any, any, any, any>> = []

  for (let sourceIndex = 0; sourceIndex < contexts.length; sourceIndex += 1) {
    for (let targetIndex = 0; targetIndex < contexts.length; targetIndex += 1) {
      if (sourceIndex === targetIndex) {
        continue
      }

      pipes.push(createChannelPipe(contexts[sourceIndex], contexts[targetIndex], {
        plugins: pluginList,
        direction: getLinkDirection(sourceIndex, targetIndex),
        propagateAbort: options.propagateAbort,
      }))
    }
  }

  let disposed = false

  return {
    pipes,
    use(plugin) {
      if (disposed) {
        throw new Error('Channel link disposed.')
      }

      pluginList.push(plugin)

      return () => {
        const index = pluginList.indexOf(plugin)

        if (index >= 0) {
          pluginList.splice(index, 1)
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
      pluginList.length = 0
    },
  }
}
