import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'adapters/broadcast-channel/index': 'src/adapters/broadcast-channel/index.ts',
    'adapters/electron/main': 'src/adapters/electron/main.ts',
    'adapters/electron/renderer': 'src/adapters/electron/renderer.ts',
    'adapters/event-emitter/index': 'src/adapters/event-emitter/index.ts',
    'adapters/event-target/index': 'src/adapters/event-target/index.ts',
    'adapters/worker-threads/index': 'src/adapters/worker-threads/index.ts',
    'adapters/worker-threads/worker/index': 'src/adapters/worker-threads/worker/index.ts',
    'adapters/webworkers/index': 'src/adapters/webworkers/index.ts',
    'adapters/webworkers/worker/index': 'src/adapters/webworkers/worker/index.ts',
    'adapters/websocket/index': 'src/adapters/websocket/index.ts',
    'adapters/websocket/h3/index': 'src/adapters/websocket/h3/index.ts',
    'adapters/websocket/native/index': 'src/adapters/websocket/native/index.ts',
  },
  dts: true,
  sourcemap: true,
  unused: true,
  fixedExtension: true,
})
