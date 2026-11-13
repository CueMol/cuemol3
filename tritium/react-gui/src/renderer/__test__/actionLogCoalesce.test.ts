/**
 * @file renderer/__test__/actionLogCoalesce.test.ts
 * @description Merging runs of the same GUI edit in the action log: once the
 * undo stack holds more steps than the limit, every run of adjacent rows that
 * wrote the same keys is merged, in the rows and in the C++ undo stack
 * (`Scene.mergeUndoSteps`), and nothing else is.
 *
 * The scene stands in for C++ `UndoManager`: `mergeUndoSteps(start, count)`
 * joins `count` steps counted from the newest, keeping the oldest one's
 * description.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Scene } from '@cuemol/core/src/wrappers/Scene'
import { fakeScene, makeWorkerCtx } from '@renderer/worker/testing'
import type { FakeScene } from '@renderer/worker/testing'
import {
  actionRows, resetActionLog, setCoalescing, setOpCoalesceLookup, txnBegin, txnEnd,
} from '@renderer/worker/server/actions/actionLog'
import type { ActionSource } from '@renderer/worker/server/actions/actionLog'
import { recordOp } from '@renderer/worker/server/actions/serviceOps'

interface StackScene extends FakeScene {
  done: string[]
}

function stackScene(): StackScene {
  const scene = fakeScene({ uid: 1 }) as StackScene
  const done: string[] = []
  let depth = 0
  let label = ''
  Object.assign(scene, {
    done,
    startUndoTxn: (l: string) => { if (depth++ === 0) label = l },
    commitUndoTxn: () => { if (--depth === 0) done.push(label) },
    rollbackUndoTxn: () => { depth = Math.max(0, depth - 1) },
    getUndoSize: () => done.length,
    getUndoDesc: (i: number) => done[done.length - 1 - i],
    getRedoSize: () => 0,
    getRedoDesc: () => '',
    mergeUndoSteps: (start: number, count: number) => {
      const oldest = done.length - start - count
      if (start < 0 || count < 2 || oldest < 0) return false
      done.splice(oldest + 1, count - 1)
      return true
    },
  })
  return scene
}

const asScene = (s: FakeScene): Scene => s as unknown as Scene
type Op = [string, Record<string, unknown>]

/** One committed transaction that records the given ops. */
function commit(scene: StackScene, ctx: ReturnType<typeof makeWorkerCtx>['ctx'], label: string, ops: Op[], source: ActionSource = 'gui'): void {
  txnBegin(asScene(scene), label, source)
  scene.startUndoTxn(label)
  for (const [op, args] of ops) recordOp(ctx, scene.uid, op, args)
  scene.commitUndoTxn()
  txnEnd(asScene(scene), true)
}

const prop = (nodeId: number, name: string, value: number): Op =>
  ['set_node_prop', { nodeType: 'renderer', nodeId, prop: name, value: String(value) }]
const toggle = (nodeId: number): Op => ['toggle_thing', { nodeId }]

const view = (scene: StackScene) =>
  actionRows(asScene(scene), scene.uid).map((r) => `${r.label}x${r.mergedCount ?? 1}`)

describe('actionLog run merging', () => {
  let scene: StackScene
  let ctx: ReturnType<typeof makeWorkerCtx>['ctx']

  beforeEach(() => {
    resetActionLog()
    setCoalescing(true, 3)
    setOpCoalesceLookup((op) => (op === 'set_node_prop' ? { last: true, key: ['nodeType', 'nodeId', 'prop'] } : { last: false, key: ['nodeId'] }))
    scene = stackScene()
    ctx = makeWorkerCtx({ scenes: [scene] }).ctx
  })
  afterEach(() => setCoalescing(true))

  it('merges nothing up to the limit, then every run at once, the newest one included', () => {
    for (const v of [1, 2, 3]) commit(scene, ctx, 'Width', [prop(7, 'width', v)])
    expect(view(scene)).toEqual(['Widthx1', 'Widthx1', 'Widthx1'])

    commit(scene, ctx, 'Other', [toggle(9)])
    for (const v of [4, 5]) commit(scene, ctx, 'Width', [prop(7, 'width', v)])
    expect(view(scene)).toEqual(['Widthx3', 'Otherx1', 'Widthx2'])
    expect(scene.done).toEqual(['Width', 'Other', 'Width'])

    // A row that comes later joins the merged run.
    commit(scene, ctx, 'Width', [prop(7, 'width', 6)])
    expect(view(scene)).toEqual(['Widthx3', 'Otherx1', 'Widthx3'])
    expect(scene.done).toHaveLength(3)
  })

  it('does not merge a different key, an edit in between, or a non-GUI source', () => {
    commit(scene, ctx, 'Width', [prop(7, 'width', 1)])
    commit(scene, ctx, 'Width', [prop(8, 'width', 1)])
    commit(scene, ctx, 'Width', [prop(8, 'radius', 1)])
    commit(scene, ctx, 'Width', [prop(8, 'radius', 2)], 'cmd')
    commit(scene, ctx, 'Width', [prop(8, 'radius', 3)])
    expect(view(scene)).toEqual(['Widthx1', 'Widthx1', 'Widthx1', 'Widthx1', 'Widthx1'])
    expect(scene.done).toHaveLength(5)
  })

  it('keeps only the newest ops of a value-setting run, every op of any other run', () => {
    // Two props per row (the Inspector's Dashed toggle writes several): both survive.
    for (const v of [1, 2, 3, 4]) commit(scene, ctx, 'Dash', [prop(7, 'stipple0', v), prop(7, 'stipple1', v)])
    const [dash] = actionRows(asScene(scene), scene.uid)
    expect(dash.entries.map((e) => e.kind === 'op' && e.args)).toEqual([
      { nodeType: 'renderer', nodeId: 7, prop: 'stipple0', value: '4' },
      { nodeType: 'renderer', nodeId: 7, prop: 'stipple1', value: '4' },
    ])

    resetActionLog()
    scene = stackScene()
    ctx = makeWorkerCtx({ scenes: [scene] }).ctx
    for (let i = 0; i < 4; i++) commit(scene, ctx, 'Toggle', [toggle(9)])
    const [tog] = actionRows(asScene(scene), scene.uid)
    expect(tog.mergedCount).toBe(4)
    expect(tog.entries).toHaveLength(4)
  })

  it('merges nothing when switched off', () => {
    setCoalescing(false, 3)
    for (const v of [1, 2, 3, 4, 5]) commit(scene, ctx, 'Width', [prop(7, 'width', v)])
    expect(scene.done).toHaveLength(5)
  })
})
