/**
 * @file plugins/pymol-console/worker/commands/motionCommands.ts
 * @description PyMOL's camera motions (`movie.roll`, `movie.rock`,
 * `movie.nutate`, `movie.tdroll`, the `movie.add_*` forms, and `rock`) as
 * animation elements.
 *
 * PyMOL writes these into the movie's frames. CueMol has a timeline of
 * elements instead, so each motion is appended at its end (SimpleSpin for a
 * turn, RockSpin for a swing), and `first` / `last` give its length only. A
 * frame is 1/30 s (PyMOL's `movie_fps` default). The result moves roughly as
 * PyMOL's does; the console is a helper, not an emulator.
 *
 * `rock` (PyMOL's interactive rocking) plays one rock cycle in a loop; the
 * `sweep_*` settings are not read, so it always rocks about y by 20 degrees
 * with an 8.4 s cycle (their defaults).
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import {
  appendMotion,
  consoleMotionRecorded,
  consoleMotionRunning,
  startConsoleLoop,
  stopConsoleLoop,
  timelineLengthMs,
  timelineSize,
  type MotionElement,
} from '@plugins/console/worker/dialect-api'
import type { CmdContext, CmdOutcome, PymCommand } from './types'
import { toNumber } from './helpers'

/** PyMOL's default `movie_fps`. */
const PYM_FPS = 30
/** PyMOL `sweep_angle` / `sweep_speed` defaults: the `rock` command's motion. */
const SWEEP_ANGLE = 20
const SWEEP_SPEED = 0.75

/** An axis word (`x`, `-y`) as the text `set_anim_prop axis` reads, or null. */
function axisText(raw: string): string | null {
  const w = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  const neg = w.startsWith('-')
  const base = neg ? w.slice(1) : w
  const v = base === 'x' ? [1, 0, 0] : base === 'y' ? [0, 1, 0] : base === 'z' ? [0, 0, 1] : null
  if (!v) return null
  return (neg ? v.map((c) => -c) : v).join(' ')
}

/** Read a number argument, or the error for it. */
function num(cmd: string, name: string, raw: string): number | CmdOutcome {
  const n = toNumber(raw)
  return n === null ? { ok: false, error: `Error: ${cmd}: ${name} must be a number: "${raw}"` } : n
}

/**
 * The frame count `first` .. `last` covers. A negative `last` means the end
 * of the movie in PyMOL; here, the end of the timeline.
 */
function frameSpan(ctx: WorkerContext, cc: CmdContext, cmd: string, firstRaw: string, lastRaw: string): number | CmdOutcome {
  const first = num(cmd, 'first', firstRaw)
  if (typeof first !== 'number') return first
  let last = num(cmd, 'last', lastRaw)
  if (typeof last !== 'number') return last
  if (last < 0) last = Math.round((timelineLengthMs(ctx, cc.sceneId) / 1000) * PYM_FPS)
  const n = last - first + 1
  if (!(n >= 1)) return { ok: false, error: `Error: ${cmd}: give last (the animation has no frames to cover)` }
  return n
}

/** Append the elements; the result as a command outcome. */
async function append(ctx: WorkerContext, cc: CmdContext, elements: MotionElement[]): Promise<CmdOutcome> {
  const res = await appendMotion(ctx, cc, 'pym', elements)
  return res.ok ? { ok: true } : res
}

/** Warn that a start frame other than the end of the movie is not followed. */
function warnStart(cc: CmdContext, cmd: string, start: string): void {
  if (start !== '' && start !== '0') cc.warn(`${cmd}: start is not used; the motion goes at the end of the animation`)
}

/** Warn that the nutation's x-to-y offset is fixed at pi/2 (radians, as PyMOL takes it). */
function warnShift(cc: CmdContext, cmd: string, raw: string): void {
  const s = toNumber(raw)
  if (s !== null && Math.abs(s - Math.PI / 2) > 1e-3) cc.warn(`${cmd}: shift is fixed at pi/2; ignored`)
}

const addRoll: PymCommand = {
  name: 'movie.add_roll',
  params: [{ name: 'duration', default: '12' }, { name: 'loop', default: '1' }, { name: 'axis', default: 'y' }, { name: 'start', default: '0' }],
  mode: 'strict',
  mutates: true,
  summary: 'Add one full turn about an axis to the end of the animation.',
  async run(ctx, args, cc) {
    const duration = num('movie.add_roll', 'duration', args.duration)
    if (typeof duration !== 'number') return duration
    const axis = axisText(args.axis)
    if (!axis) return { ok: false, error: `Error: movie.add_roll: axis must be x, y or z: "${args.axis}"` }
    warnStart(cc, 'movie.add_roll', args.start)
    return append(ctx, cc, [{ type: 'spin', durationMs: duration * 1000, props: { axis, angle: '360' } }])
  },
}

const addRock: PymCommand = {
  name: 'movie.add_rock',
  params: [
    { name: 'duration', default: '8' }, { name: 'angle', default: '30' }, { name: 'loop', default: '1' },
    { name: 'axis', default: 'y' }, { name: 'start', default: '0' },
  ],
  mode: 'strict',
  mutates: true,
  summary: 'Add one rocking cycle about an axis to the end of the animation.',
  async run(ctx, args, cc) {
    const duration = num('movie.add_rock', 'duration', args.duration)
    if (typeof duration !== 'number') return duration
    const angle = num('movie.add_rock', 'angle', args.angle)
    if (typeof angle !== 'number') return angle
    const axis = axisText(args.axis)
    if (!axis) return { ok: false, error: `Error: movie.add_rock: axis must be x, y or z: "${args.axis}"` }
    warnStart(cc, 'movie.add_rock', args.start)
    return append(ctx, cc, [{ type: 'rock', durationMs: duration * 1000, props: { pattern: 'rock', axis, angle: String(angle) } }])
  },
}

/** A nutate element: x is the primary axis, y the secondary (PyMOL's turn x, turn y). */
function nutateElement(durationMs: number, angle: number, phase: number, spiral: number): MotionElement {
  const envelope = spiral > 0 ? 'grow' : spiral < 0 ? 'shrink' : 'none'
  return { type: 'rock', durationMs, props: { pattern: 'nutate', axis: '1 0 0', angle: String(angle), phase: String(phase), envelope } }
}

const addNutate: PymCommand = {
  name: 'movie.add_nutate',
  params: [
    { name: 'duration', default: '8' }, { name: 'angle', default: '30' }, { name: 'spiral', default: '0' },
    { name: 'loop', default: '1' }, { name: 'offset', default: '0' }, { name: 'phase', default: '0' },
    { name: 'shift', default: String(Math.PI / 2) }, { name: 'start', default: '0' },
  ],
  mode: 'strict',
  mutates: true,
  summary: 'Add one nutation (the view circles its centre) to the end of the animation.',
  async run(ctx, args, cc) {
    const cmd = 'movie.add_nutate'
    const duration = num(cmd, 'duration', args.duration)
    if (typeof duration !== 'number') return duration
    const angle = num(cmd, 'angle', args.angle)
    if (typeof angle !== 'number') return angle
    const spiral = num(cmd, 'spiral', args.spiral)
    if (typeof spiral !== 'number') return spiral
    const phase = num(cmd, 'phase', args.phase)
    if (typeof phase !== 'number') return phase
    warnShift(cc, cmd, args.shift)
    warnStart(cc, cmd, args.start)
    return append(ctx, cc, [nutateElement(duration * 1000, angle, phase, spiral)])
  },
}

const roll: PymCommand = {
  name: 'movie.roll',
  params: [{ name: 'first', default: '1' }, { name: 'last', default: '-1' }, { name: 'loop', default: '1' }, { name: 'axis', default: 'y' }],
  mode: 'strict',
  mutates: true,
  summary: 'Add one full turn over frames first..last to the end of the animation.',
  async run(ctx, args, cc) {
    const n = frameSpan(ctx, cc, 'movie.roll', args.first, args.last)
    if (typeof n !== 'number') return n
    const axis = axisText(args.axis)
    if (!axis) return { ok: false, error: `Error: movie.roll: axis must be x, y or z: "${args.axis}"` }
    return append(ctx, cc, [{ type: 'spin', durationMs: (n / PYM_FPS) * 1000, props: { axis, angle: '360' } }])
  },
}

const rockMovie: PymCommand = {
  name: 'movie.rock',
  params: [
    { name: 'first', default: '1' }, { name: 'last', default: '-1' }, { name: 'angle', default: '30' },
    { name: 'phase', default: '0' }, { name: 'loop', default: '1' }, { name: 'axis', default: 'y' },
  ],
  mode: 'strict',
  mutates: true,
  summary: 'Add one rocking cycle over frames first..last to the end of the animation.',
  async run(ctx, args, cc) {
    const cmd = 'movie.rock'
    const n = frameSpan(ctx, cc, cmd, args.first, args.last)
    if (typeof n !== 'number') return n
    const angle = num(cmd, 'angle', args.angle)
    if (typeof angle !== 'number') return angle
    const phase = num(cmd, 'phase', args.phase)
    if (typeof phase !== 'number') return phase
    const axis = axisText(args.axis)
    if (!axis) return { ok: false, error: `Error: ${cmd}: axis must be x, y or z: "${args.axis}"` }
    return append(ctx, cc, [{
      type: 'rock',
      durationMs: (n / PYM_FPS) * 1000,
      props: { pattern: 'rock', axis, angle: String(angle), phase: String(phase) },
    }])
  },
}

const nutateMovie: PymCommand = {
  name: 'movie.nutate',
  params: [
    { name: 'first' }, { name: 'last' }, { name: 'angle', default: '30' }, { name: 'phase', default: '0' },
    { name: 'loop', default: '1' }, { name: 'shift', default: String(Math.PI / 2) },
  ],
  mode: 'strict',
  mutates: true,
  summary: 'Add one nutation over frames first..last to the end of the animation.',
  async run(ctx, args, cc) {
    const cmd = 'movie.nutate'
    const n = frameSpan(ctx, cc, cmd, args.first, args.last)
    if (typeof n !== 'number') return n
    const angle = num(cmd, 'angle', args.angle)
    if (typeof angle !== 'number') return angle
    const phase = num(cmd, 'phase', args.phase)
    if (typeof phase !== 'number') return phase
    warnShift(cc, cmd, args.shift)
    return append(ctx, cc, [nutateElement((n / PYM_FPS) * 1000, angle, phase, 0)])
  },
}

const tdroll: PymCommand = {
  name: 'movie.tdroll',
  params: [{ name: 'first' }, { name: 'rangex' }, { name: 'rangey' }, { name: 'rangez' }, { name: 'skip', default: '1' }],
  mode: 'strict',
  mutates: true,
  summary: 'Add turns about x, then y, then z (skip degrees a frame) to the end of the animation.',
  async run(ctx, args, cc) {
    const cmd = 'movie.tdroll'
    const skip = num(cmd, 'skip', args.skip)
    if (typeof skip !== 'number') return skip
    if (!(skip > 0)) return { ok: false, error: `Error: ${cmd}: skip must be more than 0` }
    const elements: MotionElement[] = []
    const axes: [string, string][] = [['rangex', '1 0 0'], ['rangey', '0 1 0'], ['rangez', '0 0 1']]
    for (const [name, axis] of axes) {
      const range = num(cmd, name, args[name])
      if (typeof range !== 'number') return range
      if (range === 0) continue
      // skip is degrees per frame: the turn takes ceil(range / skip) frames.
      const frames = Math.ceil(Math.abs(range) / skip)
      elements.push({ type: 'spin', durationMs: (frames / PYM_FPS) * 1000, props: { axis, angle: String(range) } })
    }
    if (elements.length === 0) return { ok: false, error: `Error: ${cmd}: every range is 0` }
    return append(ctx, cc, elements)
  },
}

const screw: PymCommand = {
  name: 'movie.screw',
  // Take the whole line, whatever it holds: the answer is the same.
  params: [{ name: 'args', default: '' }],
  mode: 'literal1',
  mutates: false,
  summary: 'Not available: the console has no camera motion that also moves along z.',
  run: () => ({ ok: false, error: 'Error: movie.screw is not supported (no motion that rocks and moves along z); use movie.rock' }),
}

/** Start rocking: resume a paused console rock, or append one cycle and loop it. */
async function startRock(ctx: WorkerContext, cc: CmdContext): Promise<CmdOutcome> {
  if (consoleMotionRunning(ctx, cc.sceneId)) return { ok: true }
  if (!consoleMotionRecorded(cc.sceneId)) {
    if (timelineSize(ctx, cc.sceneId) > 0) cc.warn('rock: the loop repeats the whole animation timeline, not just the rocking')
    const added = await appendMotion(ctx, cc, 'pym', [{
      type: 'rock',
      durationMs: ((2 * Math.PI) / SWEEP_SPEED) * 1000,
      props: { pattern: 'rock', axis: '0 1 0', angle: String(SWEEP_ANGLE) },
    }])
    if (!added.ok) return added
  }
  const started = await startConsoleLoop(ctx, cc, 'pym')
  return started.ok ? { ok: true } : started
}

/** End the console rock, if there is one (a plain timeline playback is left alone). */
async function stopRock(ctx: WorkerContext, cc: CmdContext): Promise<CmdOutcome> {
  const ended = await stopConsoleLoop(ctx, cc, 'pym')
  return ended.ok ? { ok: true } : ended
}

const rock: PymCommand = {
  name: 'rock',
  params: [{ name: 'mode', default: '-1' }],
  mode: 'strict',
  mutates: false,
  summary: 'Rock the view about y (as an animation that loops): no mode or -1 toggles, 1 starts, 0 stops.',
  async run(ctx, args, cc) {
    const mode = toNumber(args.mode)
    if (mode === null || ![-1, 0, 1].includes(mode)) return { ok: false, error: `Error: rock: mode must be -1, 0 or 1: "${args.mode}"` }
    if (mode === 1) return startRock(ctx, cc)
    if (mode === 0) return stopRock(ctx, cc)
    return consoleMotionRunning(ctx, cc.sceneId) ? stopRock(ctx, cc) : startRock(ctx, cc)
  },
}

export const MOTION_COMMANDS: PymCommand[] = [addRoll, addRock, addNutate, roll, rockMovie, nutateMovie, tdroll, screw, rock]
