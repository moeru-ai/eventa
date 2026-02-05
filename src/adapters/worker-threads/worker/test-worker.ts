import { defineInvoke, defineInvokeHandler } from '../../../invoke'
import { withTransfer } from '../../../invoke-extension-transfer'
import { defineInvokeEventa } from '../../../invoke-shared'
import { createContext } from './'

const { context: ctx } = createContext()

const invokeEvents = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-invoke')
defineInvokeHandler(ctx, invokeEvents, ({ input }) => ({ output: `Worker received: ${input}` }))

const invokeWithTransferEvents = defineInvokeEventa<{ output: string }, { input: { message: string, data: ArrayBuffer } }>('node-worker-transfer-invoke')
defineInvokeHandler(ctx, invokeWithTransferEvents, ({ input }) => ({ output: `Worker received: ${input.message}, ${input.data.byteLength} bytes` }))

const invokeReturnsTransfer = defineInvokeEventa('node-worker-return-transfer')
defineInvokeHandler(ctx, invokeReturnsTransfer, () => {
  const buffer = new ArrayBuffer(32)
  return withTransfer({ output: 'Hello from worker!', buffer }, [buffer])
})

const invokeFromWorkerThreadForMainThread = defineInvokeEventa<{ output: string }, { input: string }>('node-worker-from-worker-invoke-for-main-thread')
const invokeFromWorkerThreadEvents = defineInvokeEventa<Promise<{ output: string }>>('node-worker-from-worker-invoke')
defineInvokeHandler(ctx, invokeFromWorkerThreadEvents, async () => {
  const invoke = defineInvoke(ctx, invokeFromWorkerThreadForMainThread)
  const res = await invoke({ input: 'Hello from worker thread!' })
  return res
})
