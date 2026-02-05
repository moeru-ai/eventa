import { createContext } from '.'
import { defineInvoke, defineInvokeHandler } from '../../../invoke'
import { withTransfer } from '../../../invoke-extension-transfer'
import { defineInvokeEventa } from '../../../invoke-shared'

const { context: ctx } = createContext()

const invokeEvents = defineInvokeEventa<{ output: string }, { input: string }>('test-worker-invoke')
defineInvokeHandler(ctx, invokeEvents, ({ input }) => ({ output: `Worker received: ${input}` }))

const invokeWithTransferEvents = defineInvokeEventa<{ output: string }, { input: { message: string, data: ArrayBuffer } }>('test-worker-with-transfer-invoke')
defineInvokeHandler(ctx, invokeWithTransferEvents, ({ input }) => ({ output: `Worker received: ${input.message}, ${input.data.byteLength} bytes` }))

const invokeReturnsTransfer = defineInvokeEventa<{ output: string, buffer: ArrayBuffer }, { input: string }>('test-worker-from-worker-invoke-returns-transfer')
defineInvokeHandler(ctx, invokeReturnsTransfer, () => {
  const buffer = new ArrayBuffer(32)
  return withTransfer({ output: 'Hello from worker thread!', buffer }, [buffer])
})

const invokeFromWorkerThreadForMainThread = defineInvokeEventa<{ output: string }, { input: string }>('test-worker-from-worker-invoke-for-main-thread')
const invokeFromWorkerThreadEvents = defineInvokeEventa<Promise<{ output: string }>>('test-worker-from-worker-invoke')
defineInvokeHandler(ctx, invokeFromWorkerThreadEvents, async () => {
  const invoke = defineInvoke(ctx, invokeFromWorkerThreadForMainThread)
  const res = await invoke({ input: 'Hello from worker thread!' })
  return res
})

const invokeFromWorkerThreadForMainThreadWithTransfer = defineInvokeEventa<{ output: string }, { input: { message: string, data: ArrayBuffer } }>('test-worker-from-worker-invoke-for-main-thread-with-transfer')
const invokeFromWorkerThreadWithTransferEvents = defineInvokeEventa<Promise<{ output: string }>>('test-worker-from-worker-invoke-with-transfer')
defineInvokeHandler(ctx, invokeFromWorkerThreadWithTransferEvents, async () => {
  const invoke = defineInvoke(ctx, invokeFromWorkerThreadForMainThreadWithTransfer)
  const buffer = new ArrayBuffer(32)
  const res = await invoke({ input: { message: 'Hello from worker thread with transfer!', data: buffer } }, { transfer: [buffer] })
  return res
})
