import type { EventContext } from '../../context'

import { describe, expect, it } from 'vitest'

import healthyIframeSrcdoc from './testdata/iframe/healthy.html?raw'

import { createContext } from '.'
import { defineInvoke, defineInvokeHandler } from '../../invoke'
import { defineInvokeEventa } from '../../invoke-shared'
import { createUntil } from '../../utils'

declare global {
  interface Window {
    __eventaWindowMessageReady__?: boolean
    __eventaWindowMessageTestApi__?: {
      createContext: typeof createContext
      defineInvoke: typeof defineInvoke
      defineInvokeHandler: typeof defineInvokeHandler
      defineInvokeEventa: typeof defineInvokeEventa
    }
  }
}

interface IframeHarness {
  context: EventContext<any, { raw: { message?: MessageEvent, messageError?: MessageEvent, error?: unknown } }>
  dispose: () => void
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeout = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeout)
    }),
  ])
}

async function mountIframe(testCtx: { onTestFinished: (fn: () => void) => void }, srcdoc: string): Promise<HTMLIFrameElement> {
  const iframe = document.createElement('iframe')
  iframe.srcdoc = srcdoc

  document.body.appendChild(iframe)
  testCtx.onTestFinished(() => {
    iframe.remove()
  })

  const iframeLoaded = createUntil<void>()
  iframe.addEventListener('load', () => {
    iframeLoaded.handler()
  }, { once: true })

  await iframeLoaded.promise

  return iframe
}

function createParentHarness(iframe: HTMLIFrameElement): IframeHarness {
  return createContext({
    channel: 'window-message-browser-test',
    currentWindow: window,
    targetWindow: () => iframe.isConnected ? iframe.contentWindow : null,
    targetOrigin: '*',
  })
}

describe('window message adapter', () => {
  it('supports invoke across a parent window and iframe', async (testCtx) => {
    window.__eventaWindowMessageTestApi__ = {
      createContext,
      defineInvoke,
      defineInvokeHandler,
      defineInvokeEventa,
    }
    testCtx.onTestFinished(() => {
      delete window.__eventaWindowMessageTestApi__
    })

    let iframeBootstrapError: string | undefined
    const onBootstrapError = (event: MessageEvent) => {
      if (event.data?.type !== 'window-message-test:iframe-bootstrap-error')
        return

      iframeBootstrapError = event.data.payload?.message
    }

    window.addEventListener('message', onBootstrapError)
    testCtx.onTestFinished(() => {
      window.removeEventListener('message', onBootstrapError)
    })

    const iframe = await mountIframe(testCtx, healthyIframeSrcdoc)

    const iframeEvents = defineInvokeEventa<{ echoed: string }, { message: string }>('window-message-browser-invoke-iframe')
    const parentEvents = defineInvokeEventa<{ echoed: string }, { message: string }>('window-message-browser-invoke-parent')
    const { context, dispose } = createParentHarness(iframe)

    testCtx.onTestFinished(() => {
      dispose()
    })

    defineInvokeHandler(context, parentEvents, async (payload) => {
      return { echoed: `parent:${payload.message}` }
    })

    const invokeIframe = defineInvoke(context, iframeEvents)
    await expect(withTimeout(invokeIframe({ message: 'hello iframe' }), iframeBootstrapError ?? 'parent -> iframe invoke timed out')).resolves.toEqual({ echoed: 'iframe:hello iframe' })

    const parentResult = createUntil<{ echoed: string }>()
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'window-message-test:invoke-parent:result')
        return

      parentResult.handler(event.data.payload)
    }

    window.addEventListener('message', onMessage)
    testCtx.onTestFinished(() => {
      window.removeEventListener('message', onMessage)
    })

    iframe.contentWindow?.postMessage({
      type: 'window-message-test:invoke-parent',
      payload: { message: 'hello parent' },
    }, '*')

    await expect(withTimeout(parentResult.promise, 'iframe -> parent invoke timed out')).resolves.toEqual({ echoed: 'parent:hello parent' })
  })

  it('supports multiple concurrent invokes across a parent window and iframe', async (testCtx) => {
    window.__eventaWindowMessageTestApi__ = {
      createContext,
      defineInvoke,
      defineInvokeHandler,
      defineInvokeEventa,
    }
    testCtx.onTestFinished(() => {
      delete window.__eventaWindowMessageTestApi__
    })

    const iframe = await mountIframe(testCtx, healthyIframeSrcdoc)

    const iframeEvents = defineInvokeEventa<{ echoed: string }, { message: string }>('window-message-browser-invoke-iframe')
    const { context, dispose } = createParentHarness(iframe)

    testCtx.onTestFinished(() => {
      dispose()
    })

    const invokeIframe = defineInvoke(context, iframeEvents)

    const [result1, result2, result3] = await Promise.all([
      invokeIframe({ message: 'first' }),
      invokeIframe({ message: 'second' }),
      invokeIframe({ message: 'third' }),
    ])

    expect(result1).toEqual({ echoed: 'iframe:first' })
    expect(result2).toEqual({ echoed: 'iframe:second' })
    expect(result3).toEqual({ echoed: 'iframe:third' })
  })

  it('rejects when the iframe invoke handler throws', async (testCtx) => {
    window.__eventaWindowMessageTestApi__ = {
      createContext,
      defineInvoke,
      defineInvokeHandler,
      defineInvokeEventa,
    }
    testCtx.onTestFinished(() => {
      delete window.__eventaWindowMessageTestApi__
    })

    const iframe = await mountIframe(testCtx, healthyIframeSrcdoc)

    const iframeErrorEvents = defineInvokeEventa<{ echoed: string }, { message: string }>('window-message-browser-invoke-iframe-error')
    const { context, dispose } = createParentHarness(iframe)

    testCtx.onTestFinished(() => {
      dispose()
    })

    const invokeIframe = defineInvoke(context, iframeErrorEvents)

    await expect(invokeIframe({ message: 'explode' })).rejects.toThrowError('iframe handler failed: explode')
  })

  it('stays pending after iframe removal until the caller aborts', async (testCtx) => {
    window.__eventaWindowMessageTestApi__ = {
      createContext,
      defineInvoke,
      defineInvokeHandler,
      defineInvokeEventa,
    }
    testCtx.onTestFinished(() => {
      delete window.__eventaWindowMessageTestApi__
    })

    const iframe = await mountIframe(testCtx, healthyIframeSrcdoc)

    const iframeEvents = defineInvokeEventa<{ echoed: string }, { message: string }>('window-message-browser-invoke-iframe')
    const { context, dispose } = createParentHarness(iframe)

    testCtx.onTestFinished(() => {
      dispose()
    })

    const invokeHealthyIframe = defineInvoke(context, iframeEvents)
    await expect(withTimeout(invokeHealthyIframe({ message: 'warmup' }), 'iframe warmup invoke timed out')).resolves.toEqual({ echoed: 'iframe:warmup' })

    iframe.remove()

    const invokeIframe = defineInvoke(context, iframeEvents)
    const abortController = new AbortController()
    const promise = invokeIframe({ message: 'after removal' }, { signal: abortController.signal })

    const settled = await Promise.race([
      promise.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
    ])

    expect(settled).toBe('pending')

    abortController.abort('iframe removed')

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
