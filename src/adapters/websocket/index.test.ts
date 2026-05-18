import type { Hooks } from 'crossws'

import { plugin as ws } from 'crossws/server'
import { defineWebSocketHandler, H3, serve } from 'h3'
import { describe, expect, it } from 'vitest'

import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntil, randomBetween } from '../../utils'
import { createGlobalContext as createServerContext } from './h3'
import { createContext as createClientContext } from './native'

describe('adapters', async () => {
  it('it should work for h3 with browser', async (testCtx) => {
    const port = randomBetween(3000, 4000)

    const helloWorldEvents = defineInvokeEventa<{ output: string }, { input: string }>()

    {
      const { websocketHandlers, context: serverContext } = createServerContext()
      const app = new H3()
      app.get('/ws', defineWebSocketHandler(websocketHandlers))

      {
        const server = serve(app, {
          port,
          plugins: [ws({
            resolve: async (req) => {
              const response = (await app.fetch(req)) as Response & { crossws: Partial<Hooks> }
              return response.crossws
            },
          })],
        })
        testCtx.onTestFinished(() => {
          server.close()
        })
      }

      defineInvokeHandler(serverContext, helloWorldEvents, () => {
        return { output: 'Hello, World!' }
      })
    }

    {
      const wsConn = new WebSocket(`ws://localhost:${port}/ws`)
      const opened = createUntil<void>({
        async intervalHandler() {
          if (wsConn.readyState === WebSocket.OPEN) {
            return true
          }

          return false
        },
      })
      wsConn.onopen = () => opened.handler()
      const { context: ctx } = createClientContext(wsConn)
      await opened.promise

      const helloWorld = defineInvoke(ctx, helloWorldEvents)

      const result = await helloWorld({ input: 'Hello' })
      expect(result).toEqual({ output: 'Hello, World!' })
    }
  })
})
