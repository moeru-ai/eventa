import type { EventContext } from './context'
import type { ExtendableInvokeResponse } from './invoke'

export interface WithTransfer<T> {
  message: T
  _transfer?: Transferable[]
}

export function withTransfer<T>(body: T, transfer?: Transferable[]): ExtendableInvokeResponse<T, EventContext<{ invokeResponse?: { transfer?: Transferable[] } }, any>> {
  return {
    response: body,
    invokeResponse: {
      transfer: transfer ?? [],
    },
  }
}
