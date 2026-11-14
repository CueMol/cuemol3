/**
 * @file plugins/chimerax-console/worker/commands/motionCommands.test.ts
 * @description ChimeraX `rock` / `wobble` / `stop` as animation elements.
 *
 * Pins what a wrong conversion does not show as an error: a frame count and
 * a cycle that do not become the element's length (frames / 60 s) and its
 * number of cycles (frames / cycle), a finite motion that is added but not
 * run, and a loop setting left on after
 * `stop` when one looping motion was started after another.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import type { CmdContext } from '@plugins/console/worker/dialect-api'

// A timeline whose loop / play state follows the ops the console runs.
const { ops, mgr } = vi.hoisted(() => ({
  ops: [] as { name: string; args: Record<string, unknown> }[],
  mgr: { loop: false, playState: 'stop', size: 0, uid: 100 },
}))

vi.mock('@plugins/console/worker/runtime/opContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runOp: async (_ctx: unknown, _cc: unknown, _tag: string, name: string, args: Record<string, unknown>) => {
    ops.push({ name, args })
    if (name === 'add_anim') {
      mgr.size += 1
      return { ok: true, data: { uid: ++mgr.uid } }
    }
    if (name === 'set_anim_options' && typeof args.loop === 'boolean') mgr.loop = args.loop
    if (name === 'animate') mgr.playState = args.action === 'play' ? 'play' : 'pause'
    return { ok: true }
  },
}))
vi.mock('@renderer/worker/server/services/helpers/sceneResolver', () => ({ getSceneOrNull: () => ({}) }))
vi.mock('@renderer/worker/server/services/anim/resolve', () => ({ getAnimMgrOrNull: () => mgr }))
vi.mock('@renderer/worker/server/services/anim/read', () => ({
  readMgrState: () => ({ loop: mgr.loop, playState: mgr.playState, lengthMs: 0 }),
}))

import { VIEW_COMMANDS } from './viewCommands'
import { resetConsoleMotion } from '@plugins/console/worker/dialect-api'

const ctx = {} as WorkerContext
const cc = { sceneId: 1, viewId: 2, warn: vi.fn() } as unknown as CmdContext
const none = { center: '', coordinateSystem: '', models: '', atoms: '' }

beforeEach(() => {
  ops.length = 0
  Object.assign(mgr, { loop: false, playState: 'stop', size: 0 })
  resetConsoleMotion()
})

describe('ChimeraX motions', () => {
  it('rock with frames and a cycle becomes one RockSpin of frames/60 s and frames/cycle cycles, played once', async () => {
    const res = await VIEW_COMMANDS.rock.run(ctx, { axis: 'x', angle: '40', frames: '240', cycle: '120', ...none }, cc)
    expect(res.ok).toBe(true)
    expect(ops[0]).toEqual({ name: 'add_anim', args: { type: 'rock', name: null, before: null } })
    expect(ops[1].args).toMatchObject({ startMs: 0, endMs: 4000 })
    const props = Object.fromEntries(ops.filter((o) => o.name === 'set_anim_prop').map((o) => [o.args.prop, o.args.value]))
    expect(props).toMatchObject({ pattern: 'rock', axis: '1 0 0', cycles: '2' })
    // A finite motion plays once, from where it starts (the old end, 0 here).
    expect(ops.filter((o) => o.name === 'animate').map((o) => o.args)).toEqual([
      { action: 'seek', timeMs: 0 },
      { action: 'play', timeMs: null },
    ])
  })

  it('stop after rock then wobble (both forever) puts loop back off', async () => {
    await VIEW_COMMANDS.rock.run(ctx, { axis: '', angle: '', frames: '', cycle: '', ...none }, cc)
    expect(mgr).toMatchObject({ loop: true, playState: 'play' })
    await VIEW_COMMANDS.wobble.run(ctx, { axis: '', angle: '', frames: '', cycle: '', aspect: '', ...none }, cc)
    await VIEW_COMMANDS.stop.run(ctx, {}, cc)
    expect(mgr).toMatchObject({ loop: false, playState: 'pause' })
  })
})
