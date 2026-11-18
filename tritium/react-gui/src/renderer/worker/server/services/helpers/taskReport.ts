/**
 * @file worker/server/services/helpers/taskReport.ts
 * @description Report a long task to the renderer's long-task indicator, and
 * keep a batch runner's steps from reporting.
 *
 * Runs in the Web Worker thread.
 *
 * A service reports BEFORE its heavy synchronous part: while a C++ call runs
 * the worker cannot run JS, so a report cannot be sent later. Report on
 * low-rate changes only (start, a new file, a new step), never per frame or
 * atom; the elapsed time is counted on the renderer side.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { TaskState } from '@renderer/worker/shared/taskProgress';

/**
 * Send the state of the long task this call is running (merged into what was
 * sent before). A context without a reporter (built by hand, or muted by
 * {@link withoutTaskReport}) sends nothing.
 */
export function reportTask(ctx: WorkerContext, state: TaskState): void {
    ctx.reportTask?.(state);
}

/**
 * The same context with reports switched off. For a runner that executes
 * several operations in one call (console submission, op catalog): the call
 * outlives each operation, so an operation's report would stay on screen
 * through the next ones and time the whole batch.
 */
export function withoutTaskReport(ctx: WorkerContext): WorkerContext {
    return { ...ctx, reportTask: undefined };
}

/** The file name of a path (either separator), for a report's detail. */
export function baseName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}
