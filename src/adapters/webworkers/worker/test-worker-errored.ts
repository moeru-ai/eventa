import { defineEventa } from '../../../eventa'
import { createContext } from './'

const { context: ctx } = createContext()

const loadedEventa = defineEventa<string>('test-worker-loaded-event')
ctx.emit(loadedEventa, 'loaded')

throw new Error('Test error that should be caught by main thread.')
