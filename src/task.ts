import type { Eventa, EventTag } from './eventa'

import { defineEventa } from './eventa'

/** Lifecycle states shared by long-running operations. */
export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * A transport-neutral task notification.
 *
 * Eventa carries the state and correlation information; consumers decide how
 * to validate transitions and render the update. `stage` and `data` are
 * intentionally open-ended so a task can report provider-specific details
 * without imposing a progress-bar model on the transport layer.
 */
export interface TaskUpdate<Stage extends string = string, Data = unknown, ErrorData = unknown> {
  taskId: string
  parentTaskId?: string
  state: TaskState
  stage?: Stage
  data?: Data
  error?: ErrorData
}

export type TaskEvent<Stage extends string = string, Data = unknown, ErrorData = unknown, M = undefined, IM = undefined> = Eventa<TaskUpdate<Stage, Data, ErrorData>, M, IM>

/** Define a typed event for standalone task notifications. */
export function defineTaskEventa<Stage extends string = string, Data = unknown, ErrorData = unknown, M = undefined, IM = undefined>(
  id?: string,
  options?: { metadata?: M, invokeMetadata?: IM },
): TaskEvent<Stage, Data, ErrorData, M, IM> {
  return defineEventa<TaskUpdate<Stage, Data, ErrorData>, M, IM>(id, options)
}

/** Create a task notification for an existing correlation id. */
export function createTaskUpdate<Stage extends string = string, Data = unknown, ErrorData = unknown>(
  taskId: string,
  state: TaskState,
  options: Omit<TaskUpdate<Stage, Data, ErrorData>, 'state' | 'taskId'> = {},
): TaskUpdate<Stage, Data, ErrorData> {
  return {
    taskId,
    ...options,
    state,
  }
}

export type InferTaskUpdate<T> = T extends TaskEvent<infer Stage, infer Data, infer ErrorData, any, any>
  ? TaskUpdate<Stage, Data, ErrorData>
  : never

export type TaskEventTag<Stage extends string = string, Data = unknown, ErrorData = unknown> = EventTag<TaskUpdate<Stage, Data, ErrorData>, undefined>
