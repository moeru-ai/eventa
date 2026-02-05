# `eventa`

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

Transport-aware events powering ergonomic RPC and streaming flows.

> Heavily inspired by pragmatic RPC flows, but centred on pure events so transports stay swappable.

> [!WARNING]
> Eventa forwards whatever payload you emit. Validate data at the edges before sending it to untrusted peers.

## Installation

```sh
npm install @moeru/eventa
pnpm i @moeru/eventa
bun i @moeru/eventa
ni @moeru/eventa
yarn add @moeru/eventa
```

## Getting Started

### Event

It's very simple:

- `defineEventa`: all event should be defined with this util, it produces type safe constraints
- `context`: a channel bridges to peers (Electron, Worker, WebSocket Peer, you name it)
- `createContext`: to wrap any compatible event listener

If you need only events without RPC mechanism, then use with `context.emit(...)` and `context.on(...)`

```ts
import { createContext, defineEventa } from '@moeru/eventa'

const move = defineEventa<{ x: number, y: number }>()
const ctx = createContext()

ctx.emit(move, { x: 100, y: 200 })
ctx.on(move, ({ body }) => console.log(body.x, body.y))
```

### RPC/Stream RPC

Events can be seen as packets transferring in networks, so we can use pure event to form a RPC/Stream RPC like how gRPC and tRPC works.

- `defineInvokeEventa`: define types of RPC/Stream RPC
- `defineInvoke`: this produce a `function` returns `Promise` for your RPC call to be used later, you can store and use it everywhere you want
- `defineInvokeHandler`: similar to how Nuxt, h3 defines their handler, we use `defineInvokeHandler` to hook a auto
- `defineStreamInvokeHandler`: similar to gRPC, when one RPC invocation produces not only one response, but multiple intermediate events, you may want to use it

#### Simple Example

The most simple way to show how it works:

```ts
import { createContext, defineInvoke, defineInvokeEventa, defineInvokeHandler } from '@moeru/eventa'

const ctx = createContext()
const someMethodDefine = defineInvokeEventa<{ output: string }, { input: number }>('random name')
defineInvokeHandler(ctx, someMethodDefine, ({ input }) => ({ output: String(input) }))

const someMethod = defineInvoke(ctx, someMethodDefine)
console.log(await someMethod(42)) // => { output: '42' }
```

### Adapters

Eventa comes with various adapters for common use scenarios across browsers and Node.js, escalating the event orchestration in Electron, Web Workers, and WebSockets, etc.

<details>
  <summary>Electron</summary>

  1. Create a shared events module:
      ```ts
      import { defineInvokeEventa } from '@moeru/eventa'

      export const readdir = defineInvokeEventa<{ directories: string[] }, { cwd: string, target: string }>('rpc:node:fs/promise:readdir')
      ```

  2. In the main process, bridge the adapter to `ipcMain` and your `BrowserWindow` instance:
     ```ts
     import { createContext as createMainContext } from '@moeru/eventa/adapters/electron/main'
     import { app, BrowserWindow, ipcMain } from 'electron'

     import { readdir } from './events/readdir'

     app.on('ready', () => {
       // ... other code
       const { context: mainCtx } = createMainContext(ipcMain, mainWindow.webContents)
       defineInvokeHandler(mainCtx, readdir, async ({ cwd, target }) => {
         const fs = await import('node:fs/promises')
         const path = await import('node:path')
         const fullPath = path.resolve(cwd, target)
         const directories = await fs.readdir(fullPath, { withFileTypes: true })
         return { directories: directories.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name) }
       })
     })
     ```
  3. In the renderer (not restricted to preload scripts, but recommended), bridge to `ipcRenderer` and expose a safe API:
     ```ts
     import { createContext as createRendererContext } from '@moeru/eventa/adapters/electron/renderer'
     import { contextBridge, ipcRenderer } from 'electron'

     import { defineInvoke, readdir } from './events/readdir'

     const { context: rendererCtx } = createRendererContext(ipcRenderer)
     const invokeReaddir = defineInvoke(rendererCtx, readdir)

     document.addEventListener('DOMContentLoaded', () => {
       invokeReaddir({ cwd: '/', target: 'usr' }).then((result) => {
         console.log('directories', result.directories)
       })
     })
     ```
  4. The main and renderer contexts now share the invoke pipeline used throughout the examples in `src/adapters/electron/*.test.ts`.

</details>

<details>
  <summary>Web Worker</summary>

  1. Spawn the worker and wrap it with the main-thread adapter:
      ```ts
      import Worker from 'web-worker'

      import { createContext, defineInvoke, defineInvokeEventa } from '@moeru/eventa/adapters/webworkers'

      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      const { context: mainCtx } = createContext(worker)

      export const syncEvents = defineInvokeEventa<{ status: string }, { jobId: string }>('worker:sync')
      export const invokeSync = defineInvoke(mainCtx, syncEvents)
      ```
  2. Inside the worker entry, create the worker context and register handlers:
     ```ts
     import { defineInvokeHandler } from '@moeru/eventa'
     import { createContext } from '@moeru/eventa/adapters/webworkers/worker'

     import { syncEvents } from '../sync'

     const { context: workerCtx } = createContext()
     defineInvokeHandler(workerCtx, syncEvents, ({ jobId }) => ({ status: `synced ${jobId}` }))
     ```
  3. The same pattern works for streaming handlers and for sending transferrable(s) by switching to `defineStreamInvoke` or `defineOutboundWorkerEventa` as shown in `src/adapters/webworkers/index.spec.ts`.

</details>

<details>
  <summary>BroadcastChannel</summary>

  ```ts
  import { defineEventa } from '@moeru/eventa'
  import { createContext } from '@moeru/eventa/adapters/broadcast-channel'

  const channel = new BroadcastChannel('eventa-demo')
  const { context: ctx } = createContext(channel)

  const ping = defineEventa<{ message: string }>('bc:ping')
  ctx.on(ping, ({ body }) => {
    console.log('received', body.message)
  })

  ctx.emit(ping, { message: 'Hello from BroadcastChannel' })
  ```
</details>

<details>
  <summary>EventTarget</summary>

  ```ts
  import { defineInvoke, defineInvokeEventa, defineInvokeHandler } from '@moeru/eventa'
  import { createContext } from '@moeru/eventa/adapters/event-target'

  const eventTarget = new EventTarget()
  const { context: ctx } = createContext(eventTarget)

  const echoEvents = defineInvokeEventa<{ output: string }, { input: string }>('et:echo')
  defineInvokeHandler(ctx, echoEvents, ({ input }) => ({ output: input.toUpperCase() }))

  const echo = defineInvoke(ctx, echoEvents)
  console.log(await echo({ input: 'eventa' })) // => { output: 'EVENTA' }
  ```
</details>

<details>
  <summary>EventEmitter (Node.js)</summary>

  ```ts
  import { EventEmitter } from 'node:events'

  import { defineEventa } from '@moeru/eventa'
  import { createContext } from '@moeru/eventa/adapters/event-emitter'

  const emitter = new EventEmitter()
  const { context: ctx } = createContext(emitter)

  const logEvent = defineEventa<{ message: string }>('emitter:log')
  ctx.on(logEvent, ({ body }) => console.log(body.message))
  ctx.emit(logEvent, { message: 'Hello from EventEmitter' })
  ```
</details>

<details>
  <summary>Worker Threads (Node.js)</summary>

  1. Main thread:
      ```ts
      import { Worker } from 'node:worker_threads'

      import { defineInvoke, defineInvokeEventa } from '@moeru/eventa'
      import { createContext } from '@moeru/eventa/adapters/worker-threads'

      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      const { context: mainCtx } = createContext(worker)

      const helloEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-hello')
      const hello = defineInvoke(mainCtx, helloEvents)
      console.log(await hello({ input: 'Eventa' })) // => { output: 'Hello, Eventa' }
      ```
  2. Worker entry:
      ```ts
      import { defineInvokeEventa, defineInvokeHandler } from '@moeru/eventa'
      import { createContext } from '@moeru/eventa/adapters/worker-threads/worker'

      const helloEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-hello')

      const { context: workerCtx } = createContext()
      defineInvokeHandler(workerCtx, helloEvents, ({ input }) => ({ output: `Hello, ${input}` }))
      ```
</details>

<details>
  <summary>WebSocket (Client)</summary>

  1. Open a `WebSocket` and wrap it with the native adapter:
      ```ts
      import { defineInvoke, defineInvokeEventa } from '@moeru/eventa'
      import { createContext as createWsContext } from '@moeru/eventa/adapters/websocket/native'

      const socket = new WebSocket('wss://example.com/ws')
      const { context: wsCtx } = createWsContext(socket)

      const chatEvents = defineInvokeEventa<{ message: string }, { text: string }>('chat:send')
      export const sendChat = defineInvoke(wsCtx, chatEvents)
      ```
  2. Listen for connection lifecycle events to update UI state or retry logic:
     ```ts
     import { wsConnectedEvent, wsDisconnectedEvent } from '@moeru/eventa/adapters/websocket/native'

     wsCtx.on(wsConnectedEvent, () => console.log('connected'))
     wsCtx.on(wsDisconnectedEvent, () => console.log('disconnected'))
     ```
  3. Pair the client with either the H3 global or peer adapter on the server for a full RPC channel (`src/adapters/websocket/h3/*.test.ts`).

</details>

<details>
  <summary>WebSocket (Server with H3)</summary>

  ```ts
  import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
  // we support h3 by default, you can implement whatever you want, it's simple
  import { createContext } from '@moeru/eventa/adapters/websocket/h3'

  const chatEvents = defineInvokeEventa<{ message: string }, { text: string }>('chat:send')

  const app = new H3()
  const { untilLeastOneConnected, hooks } = createPeerHooks()
  app.get('/ws', defineWebSocketHandler(hooks))

  const { context } = await untilLeastOneConnected
  defineInvokeHandler(context, chatEvents, ({ text: string }) => {
    // you can safely throw any error you want, you can even make the error type safe when using `defineInvoke`
    return { message: `Echo: ${text}` }
  })
  ```
</details>

### Advanced Usage

#### Streaming RPC

`defineInvokeHandler` is complemented by `defineStreamInvokeHandler` for long-running operations that need to report progress or intermediate results.

```ts
import { createContext, defineInvokeEventa, defineStreamInvoke, defineStreamInvokeHandler, toStreamHandler } from '@moeru/eventa'

const ctx = createContext()
const syncEvents = defineInvokeEventa<
  { type: 'progress' | 'result', value: number },
  { jobId: string }
>('rpc:sync')

// toStreamHelper converts an async function into an async generator
// so you can use imperative code instead of a generator function.
defineStreamInvokeHandler(ctx, syncEvents, toStreamHandler(async ({ payload, emit }) => {
  emit({ type: 'progress', value: 0 })
  for (let i = 1; i <= 5; i++) {
    emit({ type: 'progress', value: i * 20 })
  }
  emit({ type: 'result', value: 100 })
}))

const sync = defineStreamInvoke(ctx, syncEvents)
for await (const update of sync({ jobId: 'import' })) {
  console.log(update.type, update.value)
}
```

Both generator-style and imperative handlers are exercised in `src/stream.spec.ts:7`.

#### Shorthands for `defineInvokeHandler` and `defineInvoke`

When you have multiple invoke events to register handlers for, or to create invoke functions for, you can use `defineInvokeHandlers` and `defineInvokes` to do so in bulk.

```ts
const events = {
  double: defineInvokeEventa<number, number>(),
  append: defineInvokeEventa<string, string>(),
}

defineInvokeHandlers(ctx, events, {
  double: input => input * 2,
  append: input => `${input}!`,
})

const {
  double: invokeDouble,
  append: invokeAppend,
} = defineInvokes(ctx, events)

await invokeDouble(5) // 10
await invokeAppend('test') // 'test!'
```

## Development

```sh
pnpm i
pnpm test
```

> [!NOTE]
> `pnpm test` runs Vitest interactively. Use `pnpm test:run` for a single pass.

## Similar projects

- [`birpc`](https://github.com/antfu-collective/birpc): We dislike the way the API designs, we want fully free sharable invok-able functions
- [`async-call-rpc`](https://github.com/Jack-Works/async-call-rpc): it only works with JSON-RPC, but the DX is similar

## License

MIT

[npm-version-src]: https://img.shields.io/npm/v/@moeru/eventa?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/@moeru/eventa
[npm-downloads-src]: https://img.shields.io/npm/dm/@moeru/eventa?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/@moeru/eventa
[bundle-src]: https://img.shields.io/bundlephobia/minzip/@moeru/eventa?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=@moeru/eventa
[license-src]: https://img.shields.io/github/license/moeru-ai/eventa.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/moeru-ai/eventa/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/@moeru/eventa
