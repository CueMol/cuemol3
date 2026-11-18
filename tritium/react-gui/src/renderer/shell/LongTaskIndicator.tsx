/**
 * @file shell/LongTaskIndicator.tsx
 * @description The card that says what long task the worker is running and
 * for how long.
 *
 * Mounted once over the content area, so it shows on every tab (a molview, the
 * Settings page...). It never takes input: the window stays usable, and
 * whatever the user does meanwhile queues behind the task as before. The bar
 * is indeterminate unless the task reports steps; then it shows the steps
 * done, so the last step in progress is not drawn as complete. When a shown
 * task ran for a while, its duration goes to the status bar once it ends.
 */

import React, { useCallback } from 'react'
import { ProgressBar } from '@blueprintjs/core'
import { useSetStatusMessage } from '@renderer/state/statusMessage'
import {
  longTaskFraction,
  longTaskTitle,
  useLongTask,
  type FinishedLongTask,
} from '@renderer/hooks/cuemol/useLongTask'

/** A task that ran at least this long leaves its duration in the status bar. */
const REPORT_DURATION_SEC = 5

export const LongTaskIndicator: React.FC = () => {
  const setStatus = useSetStatusMessage()
  const onFinished = useCallback(
    ({ task, seconds }: FinishedLongTask) => {
      if (seconds >= REPORT_DURATION_SEC) setStatus(`${longTaskTitle(task)}: ${Math.round(seconds)} s`)
    },
    [setStatus],
  )
  const shown = useLongTask(onFinished)
  if (!shown) return null

  const { task, count, elapsedSec } = shown
  const fraction = longTaskFraction(task)
  const step = task.step !== undefined && task.total !== undefined ? `${task.step} / ${task.total}` : null
  return (
    <div className="long-task-layer" aria-live="polite">
      <div className="long-task-card" role="status">
        <div className="long-task-title type-body">{task.label ?? 'Working…'}</div>
        {task.detail && <div className="long-task-detail type-caption">{task.detail}</div>}
        <ProgressBar
          className="long-task-bar"
          intent="primary"
          value={fraction ?? undefined}
          animate={fraction === null}
          stripes={fraction === null}
        />
        <div className="long-task-meta type-caption">
          {step && <span>{step}</span>}
          <span>{`${elapsedSec} s`}</span>
          {count > 1 && <span>{`+${count - 1} more`}</span>}
        </div>
      </div>
    </div>
  )
}
