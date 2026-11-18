/**
 * @file worker/shared/taskProgress.ts
 * @description What a worker service says about the long task it is running,
 * for the long-task indicator.
 *
 * A service that may hold the worker for a long time (file I/O, surface
 * generation) names itself through `ctx.reportTask` before its heavy
 * synchronous part. The worker pushes the state on `TASK_PROGRESS_CHANNEL`,
 * tagged with the seq of the call whose context sent it, and the renderer's
 * transport attaches it to that pending call. A call that never reports is
 * not shown (opt-in).
 */

/** Push channel of the task state (worker -> renderer). */
export const TASK_PROGRESS_CHANNEL = 'task-progress'

/**
 * The state of a long task. Each report is merged into the previous one, so
 * a service sends only what changed.
 */
export interface TaskState {
  /** What is being done, e.g. "Saving scene". */
  label?: string
  /** What it is done to, e.g. a file name. */
  detail?: string
  /** The step in progress, 1-based (not the number of steps done). */
  step?: number
  /** The number of steps. */
  total?: number
}

/** The pushed message: the state plus the seq of the call it belongs to. */
export interface TaskProgressMessage extends TaskState {
  seq: number
}
