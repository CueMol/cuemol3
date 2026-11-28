/**
 * @file plugins/pymol-console/worker/commands/trajCommands.test.ts
 * @description That `load_traj` (and `load` of a trajectory file) becomes the
 * MD Tools op `add_traj_block` with PyMOL's meaning.
 *
 * Pinned: the target is the object named, else the molecule named after the
 * file, else the latest molecule (PyMOL's `_guess_trajectory_object`);
 * `state` 1 (load_traj's default) replaces the frames and 0 (load's default)
 * appends; `interval` is `nevery`; the selection is translated to CueMol with
 * the object's own name as all of it; and what has no counterpart is warned
 * about.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'

const { ops, objects } = vi.hoisted(() => ({
  ops: [] as { name: string; args: Record<string, unknown> }[],
  objects: [] as { uid: number; name: string; className: string }[],
}))

vi.mock('@renderer/worker/server/catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findOp: (name: string) => ({ name }),
  invokeOp: async (op: { name: string }, _ctx: unknown, args: Record<string, unknown>) => {
    ops.push({ name: op.name, args })
    return { ok: true, data: { nframe: 10 } }
  },
}))
vi.mock('fs', () => ({ existsSync: () => true }))
vi.mock('@renderer/worker/server/services/scene/listSceneObjects', () => ({
  listSceneObjects: () => ({ objects }),
}))

import { TRAJ_COMMANDS } from './trajCommands'
import { FILE_COMMANDS } from './fileCommands'
import type { CmdContext } from './types'

const ctx = { strMgr: { getInfoJSON2: () => '[]' } } as unknown as WorkerContext
const warn = vi.fn()
const cc = {
  sceneId: 1,
  viewId: 2,
  cwd: '/data',
  print: vi.fn(),
  warn,
  markMutated: vi.fn(),
  streamId: (tag: string) => tag,
  noteStream: vi.fn(),
  stopped: () => false,
} as unknown as CmdContext

/** The command's defaults with `over` written over them, as the parser binds them. */
function bound(name: string, over: Record<string, string>, list = TRAJ_COMMANDS): Record<string, string> {
  const cmd = list.find((c) => c.name === name)!
  return { ...Object.fromEntries(cmd.params.map((p) => [p.name, p.default ?? ''])), ...over }
}

beforeEach(() => {
  ops.length = 0
  warn.mockClear()
  objects.splice(0, objects.length,
    { uid: 3, name: 'prot', className: 'MolCoord' },
    { uid: 9, name: 'sys', className: 'MolCoord' },
    { uid: 12, name: 'map1', className: 'DensityMap' },
  )
})

describe('load_traj', () => {
  it('fills the latest molecule from state 1, every Nth frame, with a translated selection', async () => {
    const cmd = TRAJ_COMMANDS.find((c) => c.name === 'load_traj')!
    const res = await cmd.run(ctx, bound('load_traj', { filename: 'md.dcd', interval: '2', selection: 'sys and name CA', start: '5' }), cc)

    expect(res).toMatchObject({ ok: true })
    expect(ops).toEqual([{
      name: 'add_traj_block',
      args: { objId: 9, paths: ['/data/md.dcd'], reader: null, nevery: 2, loadSel: expect.stringMatching(/CA/), replace: true },
    }])
    expect((ops[0].args.loadSel as string)).not.toMatch(/sys/)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/start is ignored/))
  })

  it('load of a trajectory file appends to the molecule named after it (state 0)', async () => {
    objects.push({ uid: 20, name: 'other', className: 'MolCoord' })
    const load = FILE_COMMANDS.find((c) => c.name === 'load')!
    const res = await load.run(ctx, bound('load', { filename: 'prot.xtc' }, FILE_COMMANDS), cc)

    expect(res).toMatchObject({ ok: true })
    expect(ops).toEqual([{
      name: 'add_traj_block',
      args: expect.objectContaining({ objId: 3, paths: ['/data/prot.xtc'], replace: null }),
    }])
  })
})
