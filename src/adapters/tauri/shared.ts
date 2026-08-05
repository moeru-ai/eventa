import type { AdapterErrorPayload } from '../errors'

import { defineEventa } from '../../eventa'

export type { AdapterErrorKind, AdapterErrorPayload } from '../errors'

/**
 * Emitted when a Tauri message cannot be parsed or an invoke cannot be sent.
 * A malformed message does not abort the context because the underlying Tauri
 * event transport is still usable.
 */
export const errorEvent = defineEventa<AdapterErrorPayload>('eventa:tauri:error')
