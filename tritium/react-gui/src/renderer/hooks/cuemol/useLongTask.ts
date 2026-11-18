/**
 * @file hooks/cuemol/useLongTask.ts
 * @description The long task to show: a worker call that reported its task
 * (`ctx.reportTask`) and has been running for longer than the threshold.
 *
 * Timing only; what to draw is the caller's. A call shorter than
 * `LONG_TASK_THRESHOLD_MS` never shows, so ordinary operations do not
 * flicker; once shown, a task stays for at least `LONG_TASK_MIN_SHOW_MS` so
 * it can be read. The elapsed time is counted here on the main thread -- the
 * worker cannot report while a C++ call holds it -- so it shows how long the
 * call has run, not that the worker is making progress.
 */

import { useEffect, useRef, useState } from 'react'
import { useCueMol } from '@renderer/hooks/cuemol/useCueMol'
import { useLatestRef } from '@renderer/hooks/react/useLatestRef'
import type { LongTask } from '@renderer/worker/client/WorkerTransport'

/** A reported call shows once it has run this long. */
export const LONG_TASK_THRESHOLD_MS = 800
/** A shown task stays at least this long. */
export const LONG_TASK_MIN_SHOW_MS = 300
/** The elapsed time is redrawn this often while shown. */
const TICK_MS = 500

export interface ShownLongTask {
  task: LongTask
  /** Reported calls pending, including this one. */
  count: number
  /** Whole seconds since the call was sent. */
  elapsedSec: number
}

/** A finished long task, for a one-line summary. */
export interface FinishedLongTask {
  task: LongTask
  /** Seconds the call ran. */
  seconds: number
}

/**
 * The determinate bar's fraction: the steps DONE over the total, so a task on
 * its last step is not drawn as complete. Null when the task has no steps.
 */
export function longTaskFraction(task: Pick<LongTask, 'step' | 'total'>): number | null {
  if (task.step === undefined || task.total === undefined || task.total <= 0) return null
  return Math.min(1, Math.max(0, (task.step - 1) / task.total))
}

/** "Saving scene -- 1abc.qsc" (the label falls back to "Working..."). */
export function longTaskTitle(task: Pick<LongTask, 'label' | 'detail'>): string {
  const label = task.label ?? 'Working…'
  return task.detail ? `${label} — ${task.detail}` : label
}

/**
 * The long task to show now, or null.
 *
 * @param onFinished - Called once when a shown task ends (not when it was
 *   never shown), with how long it ran.
 */
export function useLongTask(onFinished?: (f: FinishedLongTask) => void): ShownLongTask | null {
  const { cueMolReady, cm } = useCueMol()
  const [shown, setShown] = useState<ShownLongTask | null>(null)
  const onFinishedRef = useLatestRef(onFinished)
  // The task on screen and when it appeared, for the minimum display time.
  const shownRef = useRef<{ task: LongTask; since: number } | null>(null)

  useEffect(() => {
    if (!cueMolReady || !cm) return
    let current: LongTask | null = null
    let count = 0
    let showTimer: ReturnType<typeof setTimeout> | null = null
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let tick: ReturnType<typeof setInterval> | null = null

    const clear = (t: ReturnType<typeof setTimeout> | null) => { if (t !== null) clearTimeout(t) }
    const render = () => {
      const s = shownRef.current
      if (!s) { setShown(null); return }
      // A newer report of the same call (detail, step) replaces the shown one.
      const task = current && current.seq === s.task.seq ? current : s.task
      setShown({ task, count: Math.max(count, 1), elapsedSec: Math.floor((performance.now() - task.startedAt) / 1000) })
    }
    const show = (task: LongTask) => {
      shownRef.current = { task, since: performance.now() }
      if (tick === null) tick = setInterval(render, TICK_MS)
      render()
    }
    const hide = () => {
      const s = shownRef.current
      shownRef.current = null
      if (tick !== null) { clearInterval(tick); tick = null }
      setShown(null)
      if (s) onFinishedRef.current?.({ task: s.task, seconds: (performance.now() - s.task.startedAt) / 1000 })
    }

    const apply = () => {
      const snap = cm.getLongTasks()
      current = snap.current
      count = snap.count
      const s = shownRef.current
      if (s && current?.seq === s.task.seq) {
        shownRef.current = { task: current, since: s.since }
        render()
        return
      }
      if (s) {
        // The shown task ended (or an older one is next): keep it up for
        // the minimum time, then move on.
        clear(hideTimer)
        const wait = Math.max(0, s.since + LONG_TASK_MIN_SHOW_MS - performance.now())
        hideTimer = setTimeout(() => {
          hideTimer = null
          hide()
          apply()
        }, wait)
        return
      }
      clear(showTimer)
      showTimer = null
      if (!current) return
      const task = current
      const wait = Math.max(0, task.startedAt + LONG_TASK_THRESHOLD_MS - performance.now())
      showTimer = setTimeout(() => {
        showTimer = null
        if (cm.getLongTasks().current?.seq === task.seq) show(cm.getLongTasks().current!)
      }, wait)
    }

    apply()
    const unsubscribe = cm.subscribeLongTasks(apply)
    return () => {
      unsubscribe()
      clear(showTimer)
      clear(hideTimer)
      if (tick !== null) clearInterval(tick)
      shownRef.current = null
    }
  }, [cueMolReady, cm, onFinishedRef])

  return shown
}
