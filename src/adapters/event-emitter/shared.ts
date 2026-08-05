import { defineEventa } from '../../eventa'

export const errorEvent = { ...defineEventa<{ error: unknown }>() }
