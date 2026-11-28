/**
 * Contract test for what the MD trajectory services record for the action
 * log (recordTraj.ts).
 *
 * Pinned: each GUI edit of a trajectory (open, add / drop, remove, reorder)
 * is recorded as its op with arguments that op reads back, so a History row
 * can be saved to Actions and run again; a reorder is recorded as the places
 * the block moved (`by`); and a file list survives the qax form one <arg> per
 * file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { records } = vi.hoisted(() => ({
  records: [] as { op: string; args: Record<string, unknown>; refs: readonly string[] }[],
}))

vi.mock('@renderer/worker/server/actions/serviceOps', async (orig) => ({
  ...(await orig<typeof import('@renderer/worker/server/actions/serviceOps')>()),
  recordOp: (_ctx: unknown, _sceneId: number, op: string, args: Record<string, unknown>, refs: readonly string[] = []) =>
    records.push({ op, args, refs }),
  recordedRendererName: () => null,
}))

import { findOp } from '@renderer/worker/server/catalog'
import { readToolArgs } from '@renderer/worker/server/catalog/toolSchema'
import { opToQax, qaxToInput } from '@renderer/worker/server/actions/qax/values'
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes'
import { recordAddTrajBlock, recordLoadTrajectory, recordMoveTrajBlock, recordRemoveTrajBlock } from './recordTraj'
import './mdtools.service'

const ctx = {} as never
const renderer = {
  objectName: 'sys',
  rendererType: 'simple',
  rendererName: 'simple1',
  selectionEnabled: false,
  selection: '*',
  centerView: true,
  mapCenterPolicy: 'auto',
} as RendererOptions

beforeEach(() => { records.length = 0 })

describe('MD trajectory records', () => {
  it('records each GUI edit as its op, with arguments the op reads back', () => {
    recordLoadTrajectory(ctx, 1, { topology: '/d/sys.gro', paths: ['/d/a.xtc', '/d/b.xtc'], reader: null, nevery: 2, loadSel: null, renderer })
    recordAddTrajBlock(ctx, 1, { objId: 5, paths: ['/d/c.dcd'], reader: null, nevery: 1, loadSel: 'name CA', replace: true })
    recordRemoveTrajBlock(ctx, 1, 5, 0)
    recordMoveTrajBlock(ctx, 1, 5, 2, 0)

    expect(records.map((r) => r.op)).toEqual(['load_trajectory', 'add_traj_block', 'remove_traj_block', 'move_traj_block'])
    for (const r of records) {
      const op = findOp(r.op)!
      expect(Object.keys(r.args).filter((k) => !(k in op.params)), r.op).toEqual([])
      expect(typeof readToolArgs(op, r.args), `${r.op}: ${String(readToolArgs(op, r.args))}`).toBe('object')
    }
    expect(records[3].args).toEqual({ objId: 5, index: 2, by: -2 })
    expect(records[1].refs).toEqual(['objId'])
  })

  it('keeps a file list through the qax form, in order', () => {
    recordLoadTrajectory(ctx, 1, { topology: '/d/sys.gro', paths: ['/d/a.xtc', '/d/b.xtc'], reader: null, nevery: 1, loadSel: null, renderer })
    const op = findOp('load_trajectory')!
    const item = opToQax(op.name, op.params, records[0].args)
    if (item.kind !== 'op') throw new Error('not an op')
    const back = qaxToInput(item, op.params, () => ({ error: 'no node' }))
    if (!back.ok) throw new Error(back.error)
    expect(readToolArgs(op, back.input)).toMatchObject({ topology: '/d/sys.gro', paths: ['/d/a.xtc', '/d/b.xtc'] })
  })
})
