import { describe, expect, it } from 'vitest'

import { createContext } from './context'
import { defineEventa } from './eventa'
import { defineInvoke } from './invoke'
import { defineInvokeEventa } from './invoke-shared'
import { registerInvokeAbortEventListeners } from './context-extension-invoke-internal'

describe('context-extension-invoke-internal', () => {
  it('should reject pending invoke when abort event fires', async () => {
    const ctx = createContext()
    const events = defineInvokeEventa<void, void>()
    const fatalEvent = defineEventa<{ error: Error }>('fatal-event')

    registerInvokeAbortEventListeners(ctx, fatalEvent)

    const invoke = defineInvoke(ctx, events)
    const promise = invoke()

    const error = new Error('worker failed')
    ctx.emit(fatalEvent, { error })

    await expect(promise).rejects.toBe(error)
  })
})
