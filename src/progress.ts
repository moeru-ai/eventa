import type { Eventa, EventTag } from './eventa'

import { defineEventa } from './eventa'

/** Lifecycle states shared by long-running operations. */
export type ProgressStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * A transport-neutral progress update.
 *
 * `progress` is a normalized value between 0 and 1. Integrations can put
 * domain-specific information in `data` without making the transport aware
 * of the operation being performed.
 */
export interface ProgressUpdate<Stage extends string = string, Data = unknown> {
  type: 'progress'
  /** Correlates standalone progress events; stream invokes already have an invoke id. */
  taskId?: string
  status: ProgressStatus
  stage?: Stage
  progress?: number
  message?: string
  data?: Data
}

export type ProgressEvent<Stage extends string = string, Data = unknown, M = undefined, IM = undefined> = Eventa<ProgressUpdate<Stage, Data>, M, IM>

/** Define a typed event for standalone progress updates. */
export function defineProgressEventa<Stage extends string = string, Data = unknown, M = undefined, IM = undefined>(
  id?: string,
  options?: { metadata?: M, invokeMetadata?: IM },
): ProgressEvent<Stage, Data, M, IM> {
  return defineEventa<ProgressUpdate<Stage, Data>, M, IM>(id, options)
}

/**
 * Create a progress update and validate its normalized percentage.
 * Omitting `progress` is useful for lifecycle-only updates such as queued or
 * failed; completed updates may still provide a final value of 1 explicitly.
 */
export function createProgressUpdate<Stage extends string = string, Data = unknown>(
  status: ProgressStatus,
  options: Omit<ProgressUpdate<Stage, Data>, 'type' | 'status'> = {},
): ProgressUpdate<Stage, Data> {
  if (options.progress !== undefined && (options.progress < 0 || options.progress > 1 || !Number.isFinite(options.progress))) {
    throw new RangeError('Progress must be a finite number between 0 and 1')
  }

  return {
    type: 'progress',
    status,
    ...options,
  }
}

export type InferProgressUpdate<T> = T extends ProgressEvent<infer Stage, infer Data, any, any>
  ? ProgressUpdate<Stage, Data>
  : never

export type ProgressEventTag<Stage extends string = string, Data = unknown> = EventTag<ProgressUpdate<Stage, Data>, undefined>
