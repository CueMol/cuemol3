/**
 * @file __test__/longTaskProgress.test.ts
 * @description The long-task indicator's contract across the worker boundary.
 *
 * - The worker tags a task report with the seq of the call whose context
 *   sent it, also after an `await` that let another call run in between.
 * - The transport keeps a report only while its tracked call is pending, and
 *   drops one for a quiet call or a call already replied to.
 * - An op (console, macro, agent, MCP) does not let the services it runs
 *   report: those batches are not one task.
 * - The bar shows the steps done, so the last step in progress is not 100%.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@cuemol/core', () => ({ getModule: () => ({}) }))
vi.mock('@cuemol/core/src/cuemol', () => ({ CueMol: class { constructor(_o: unknown) { void _o } } }))
vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))

let capturedWorker: MockWorker | null = null
class MockWorker {
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor(_url: unknown) { capturedWorker = this }
}

import { WorkerService } from '@renderer/worker/server/WorkerService'
import { WorkerTransport } from '@renderer/worker/client/WorkerTransport'
import { invokeOp } from '@renderer/worker/server/catalog/opRuntime'
import { TASK_PROGRESS_CHANNEL } from '@renderer/worker/shared/taskProgress'
import { longTaskFraction } from '@renderer/hooks/cuemol/useLongTask'
import { makeWorkerCtx } from '@renderer/worker/testing'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('worker: ctx.reportTask', () => {
  it('reports to the call that made the context, across an await', async () => {
    const posted: unknown[][] = []
    const svc = new WorkerService((d: unknown[]) => { posted.push(d) }, () => {})
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const register = (svc.register as unknown as (n: string, f: AnyFn) => void).bind(svc)
    register('slow', async (ctx: WorkerContext) => {
      await gate
      ctx.reportTask?.({ label: 'Slow' })
      return { ok: true }
    })
    register('quick', (ctx: WorkerContext) => {
      ctx.reportTask?.({ label: 'Quick' })
      return { ok: true }
    })

    svc.invoke('slow', 1, [{}])
    svc.invoke('quick', 2, [{}])
    await flush()
    release()
    await flush()

    const reports = posted.filter((m) => m[0] === TASK_PROGRESS_CHANNEL).map((m) => m[1])
    expect(reports).toEqual([{ seq: 2, label: 'Quick' }, { seq: 1, label: 'Slow' }])
  })
})

describe('transport: long tasks', () => {
  let tr: WorkerTransport
  const send = (data: unknown[]) => capturedWorker!.onmessage?.({ data } as MessageEvent)
  const lastSeq = () => (capturedWorker!.postMessage.mock.calls.at(-1)![0] as unknown[])[1] as number

  beforeEach(() => {
    vi.stubGlobal('Worker', MockWorker)
    tr = new WorkerTransport({ onEventNotify: () => undefined })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('holds a report while its call is pending and forgets it on the reply', async () => {
    const listener = vi.fn()
    tr.subscribeLongTasks(listener)
    const call = tr.invokeWorker('saveScene', {})
    const seq = lastSeq()
    expect(tr.getLongTasks()).toEqual({ current: null, count: 0 })

    send([TASK_PROGRESS_CHANNEL, { seq, label: 'Saving scene' }])
    send([TASK_PROGRESS_CHANNEL, { seq, detail: 'a.qsc' }])
    expect(tr.getLongTasks().current).toMatchObject({ seq, name: 'saveScene', label: 'Saving scene', detail: 'a.qsc' })

    send(['saveScene', seq, true, { ok: true }])
    await call
    expect(tr.getLongTasks()).toEqual({ current: null, count: 0 })
    // A report that arrives after the reply belongs to nothing.
    send([TASK_PROGRESS_CHANNEL, { seq, label: 'late' }])
    expect(tr.getLongTasks().count).toBe(0)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('drops a report for a quiet call', () => {
    void tr.invokeService('saveScene' as never, {} as never, { quiet: true })
    send([TASK_PROGRESS_CHANNEL, { seq: lastSeq(), label: 'Saving scene' }])
    expect(tr.getLongTasks().count).toBe(0)
  })
})

describe('op: no task reports', () => {
  it('runs the op with a context whose reportTask is gone', async () => {
    const { ctx } = makeWorkerCtx({})
    const reportTask = vi.fn()
    let seen: unknown = 'unset'
    const op = {
      name: 'test_op',
      params: {},
      mutates: false,
      run: async (c: WorkerContext) => {
        seen = c.reportTask
        c.reportTask?.({ label: 'x' })
        return { ok: true }
      },
    }
    const oc = { sceneId: 0, viewId: 0, callId: 'c', markMutated: () => undefined } as never
    await invokeOp(op as never, { ...ctx, reportTask } as WorkerContext, {}, oc)
    expect(seen).toBeUndefined()
    expect(reportTask).not.toHaveBeenCalled()
  })
})

describe('longTaskFraction', () => {
  it('counts the steps done, not the step in progress', () => {
    expect(longTaskFraction({ step: 1, total: 4 })).toBe(0)
    expect(longTaskFraction({ step: 4, total: 4 })).toBe(0.75)
    expect(longTaskFraction({})).toBeNull()
  })
})
