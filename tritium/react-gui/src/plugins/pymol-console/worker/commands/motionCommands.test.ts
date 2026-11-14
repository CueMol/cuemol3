/**
 * @file plugins/pymol-console/worker/commands/motionCommands.test.ts
 * @description PyMOL `movie.tdroll` and `rock` as animation elements.
 *
 * Pins `skip` read as degrees per frame (the turn's length is range/skip
 * frames, not range*skip), and `rock`'s modes: 1 / 0 start / stop and do not
 * toggle, a console rock paused from the GUI resumes on `rock 1` without a
 * second element, and `rock 0` while paused still puts the loop back.
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

import { MOTION_COMMANDS } from './motionCommands'
import { resetConsoleMotion } from '@plugins/console/worker/dialect-api'

const ctx = {} as WorkerContext
const cc = { sceneId: 1, viewId: 2, warn: vi.fn() } as unknown as CmdContext
const cmd = (name: string) => MOTION_COMMANDS.find((c) => c.name === name)!
const adds = () => ops.filter((o) => o.name === 'add_anim').length

beforeEach(() => {
  ops.length = 0
  Object.assign(mgr, { loop: false, playState: 'stop', size: 0 })
  resetConsoleMotion()
})

describe('PyMOL motions', () => {
  it('movie.tdroll turns about each non-zero axis in turn, skip degrees a frame', async () => {
    await cmd('movie.tdroll').run(ctx, { first: '1', rangex: '360', rangey: '360', rangez: '0', skip: '5' }, cc)
    expect(ops.filter((o) => o.name === 'add_anim').map((o) => o.args.type)).toEqual(['spin', 'spin'])
    // 360 / 5 = 72 frames at 30 fps.
    expect(ops.filter((o) => o.name === 'set_anim_time').map((o) => o.args.endMs)).toEqual([2400, 2400])
    const axes = ops.filter((o) => o.name === 'set_anim_prop' && o.args.prop === 'axis').map((o) => o.args.value)
    expect(axes).toEqual(['1 0 0', '0 1 0'])
  })

  it('rock 1 / rock 0 start and stop, resume after a GUI pause, and put loop back while paused', async () => {
    const rock = cmd('rock')
    await rock.run(ctx, { mode: '1' }, cc)
    expect(mgr).toMatchObject({ loop: true, playState: 'play' })
    await rock.run(ctx, { mode: '1' }, cc) // already rocking: not a toggle
    expect(mgr.playState).toBe('play')
    expect(adds()).toBe(1)

    mgr.playState = 'pause' // paused from the Animation panel
    await rock.run(ctx, { mode: '1' }, cc)
    expect(mgr.playState).toBe('play')
    expect(adds()).toBe(1) // resumed, no second element

    mgr.playState = 'pause'
    await rock.run(ctx, { mode: '0' }, cc)
    expect(mgr.loop).toBe(false)
    await rock.run(ctx, { mode: '0' }, cc) // nothing to stop: not a toggle
    expect(mgr.playState).toBe('pause')
  })
})
