/**
 * @file plugins/chimerax-console/worker/commands/viewCommands.ts
 * @description The camera: `turn`, `move`, `cofr`, `zoom`, named views and
 * `view matrix`, plus `set bgColor` and `graphics silhouettes`.
 *
 * Each move is a camera op (`set_view`, `set_projection`, the camera ops),
 * which is not an undo step (op-catalog.md). The camera is read from the
 * view (`camera.ts`), as `view` already does.
 *
 * How CueMol's camera relates to ChimeraX's, worked out on the view:
 * - world axis = R(q) x screen axis, with `forward_vec` the screen's +z
 *   (toward the viewer); ChimeraX's camera looks along its -z the same way.
 * - CueMol turns about the view centre; there is no separate centre of
 *   rotation, which is why `cofr` with a target is refused.
 * - `zoom` is the height of the view in angstroms, so a pixel is
 *   zoom / height angstroms there.
 *
 * Animation (`frames`) is not played: a finite count is applied at once,
 * multiplied in as ChimeraX repeats the step every frame (`turn y 3 30` is
 * 90 degrees), and `forever` is refused.
 */

import type { CmdOutcome, CmdContext, MotionElement } from '@plugins/console/worker/dialect-api'
import { appendMotion, playFrom, startConsoleLoop, stopConsoleLoop, timelineLengthMs, timelinePlaying, timelineSize } from '@plugins/console/worker/dialect-api'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import { objectNodes, rendererNodesOf } from '@renderer/worker/server/catalog/refs'
import { getGenericProps } from '@renderer/worker/server/services/props/read'
import { AxisArg, BoolArg, ColorArg, EnumOf, FloatArg, IntArg, SpecArg, StringArg } from '../cli/argTypes'
import { chxCommand } from '../cli/command'
import type { ChxCommand } from '../cli/command'
import { splitColorArg } from '../colors'
import {
  cameraFromMatrix,
  cameraMatrix,
  framingOf,
  g5,
  pixelSize,
  readCamera,
  turnedRotation,
} from '../camera'
import type { CameraState } from '../camera'
import { runOp, targetsOf } from '../display'
import { unsupported } from './warn'

// --- Helpers ---

/** An axis argument (`x`, `-y`, `1,1,0`) as a unit vector in screen coordinates. */
export function axisOf(raw: string): [number, number, number] | null {
  const named: Readonly<Record<string, [number, number, number]>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  const w = raw.trim().toLowerCase()
  const neg = w.startsWith('-')
  const base = named[neg ? w.slice(1) : w]
  if (base) return neg ? [-base[0], -base[1], -base[2]] : base
  const nums = w.split(',').map(Number)
  if (nums.length !== 3 || !nums.every(Number.isFinite)) return null
  const n = Math.hypot(...nums)
  return n === 0 ? null : [nums[0] / n, nums[1] / n, nums[2] / n]
}

/** A `frames` count multiplied into one step; null when it is `forever` or malformed. */
function framesOf(raw: string): number | null {
  if (raw === '') return 1
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Refuse the keywords that move models or atoms, or set the centre: the console moves the camera only (so far). */
function refuseGiven(cmd: string, args: Record<string, string>, names: readonly string[], why: string): CmdOutcome | null {
  const given = names.find((n) => args[n] !== undefined && args[n] !== '')
  return given ? unsupported(`Error: ${cmd}: ${given} is not supported yet (${why})`) : null
}

/** The camera, or the error for when there is no view. */
function cameraOf(ctx: WorkerContext, cc: CmdContext): CameraState | { ok: false; error: string } {
  return readCamera(ctx, cc.viewId) ?? { ok: false, error: 'Error: no active view' }
}

/** `set_view` with only the fields given; the rest are left as they are. */
async function setView(ctx: WorkerContext, cc: CmdContext, change: Record<string, unknown>): Promise<CmdOutcome> {
  const res = await runOp(ctx, cc, 'set_view', {
    zoom: null, slab: null, distance: null, center: null, rotation: null, fitSlab: null, objId: null, ...change,
  })
  return res.ok ? { ok: true } : res
}

// --- turn / move ---

/** ChimeraX draws at 60 frames a second: a frame count becomes time at this rate. */
const CHX_FPS = 60

/**
 * The motion keywords turn / roll / rock / wobble share (`turn.py`). The
 * console moves the camera about the view centre, so the keywords that move
 * models or set the centre are refused.
 */
const MOTION_ARGS = [
  { name: 'center', type: StringArg, role: 'keyword' },
  { name: 'coordinateSystem', type: StringArg, role: 'keyword' },
  { name: 'models', type: StringArg, role: 'keyword' },
  { name: 'atoms', type: StringArg, role: 'keyword' },
] as const
const MOTION_REFUSED = ['center', 'coordinateSystem', 'models', 'atoms'] as const
const MOTION_WHY = 'the console turns the camera about the view centre and does not move models'

/** A motion as `turn.py` reads its arguments. */
interface MotionRequest {
  cmd: string
  axis: [number, number, number]
  /** Degrees per frame (turn / roll), or the full swing (rock / wobble). */
  angle: number
  /** A frame count, `forever`, or '' (forever for roll / rock / wobble). */
  frames: string
  /** `rock N` / `wobble N`: frames per cycle ('' = neither). */
  rock: string
  wobble: string
  wobbleAspect: string
}

/**
 * Append a motion to the animation timeline as one element and run it: a
 * motion with a frame count plays once from where it starts, one without an
 * end (frames forever) plays one cycle of it in a loop until `stop`. Speeds and phases follow ChimeraX only roughly: the console is a
 * helper, not an emulator.
 */
async function appendChxMotion(ctx: WorkerContext, cc: CmdContext, m: MotionRequest): Promise<CmdOutcome> {
  if (m.rock !== '' && m.wobble !== '') return { ok: false, error: `Error: ${m.cmd}: give rock or wobble, not both` }
  const cycleRaw = m.rock !== '' ? m.rock : m.wobble
  const forever = m.frames === 'forever' || m.frames === ''
  const frames = forever ? 0 : Number(m.frames)
  if (!forever && !(Number.isInteger(frames) && frames > 0)) {
    return { ok: false, error: `Error: ${m.cmd}: frames must be a whole number or forever` }
  }
  // The console's turn turns the camera the other way to the scene (see
  // turnedRotation); the element does the same so both agree.
  const sign = -1
  const axis = m.axis.join(' ')
  let el: MotionElement
  if (cycleRaw !== '') {
    const cycle = Number(cycleRaw)
    if (!(Number.isInteger(cycle) && cycle > 0)) return { ok: false, error: `Error: ${m.cmd}: the cycle must be a whole number of frames` }
    const props: Record<string, string> = {
      pattern: m.wobble !== '' ? 'wobble' : 'rock',
      axis,
      angle: String(sign * m.angle),
      cycles: String(forever ? 1 : frames / cycle),
    }
    if (m.wobble !== '' && m.wobbleAspect !== '') props.aspect = m.wobbleAspect
    el = { type: 'rock', durationMs: ((forever ? cycle : frames) / CHX_FPS) * 1000, props }
  } else {
    if (m.angle === 0) return { ok: false, error: `Error: ${m.cmd}: the angle must not be 0` }
    // Forever: one full turn in the angle's direction, at its speed.
    const total = forever ? Math.sign(m.angle) * 360 : m.angle * frames
    const n = forever ? 360 / Math.abs(m.angle) : frames
    el = { type: 'spin', durationMs: (n / CHX_FPS) * 1000, props: { axis, angle: String(sign * total) } }
  }
  if (forever && timelineSize(ctx, cc.sceneId) > 0) {
    cc.warn(`${m.cmd}: the loop repeats the whole animation timeline, not just this motion`)
  }
  // The new element goes at the end, so it starts where the timeline ends now.
  const startMs = timelineLengthMs(ctx, cc.sceneId)
  const added = await appendMotion(ctx, cc, 'chx', [el])
  if (!added.ok) return added
  if (!forever) {
    const played = await playFrom(ctx, cc, 'chx', startMs)
    return played.ok ? { ok: true } : played
  }
  const started = await startConsoleLoop(ctx, cc, 'chx')
  return started.ok ? { ok: true } : started
}

/** Read the axis argument, or the error for it. */
function motionAxis(cmd: string, raw: string): [number, number, number] | CmdOutcome {
  return axisOf(raw || 'y') ?? { ok: false, error: `Error: ${cmd}: "${raw}" is not an axis (x, y, z or three numbers)` }
}

const turn = chxCommand({
  words: ['turn'],
  args: [
    { name: 'axis', type: AxisArg, role: 'optional' },
    { name: 'angle', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'rock', type: StringArg, role: 'keyword' },
    { name: 'wobble', type: StringArg, role: 'keyword' },
    { name: 'wobbleAspect', type: StringArg, role: 'keyword' },
    ...MOTION_ARGS,
  ],
  mutates: false,
  summary: 'Turn the scene about a screen axis (default y, 90 degrees); with frames, rock or wobble, add it to the animation.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('turn', args, MOTION_REFUSED, MOTION_WHY)
    if (refused) return refused
    const axis = motionAxis('turn', args.axis)
    if (!Array.isArray(axis)) return axis
    const angle = args.angle === '' ? 90 : Number(args.angle)
    if (args.frames !== '' || args.rock !== '' || args.wobble !== '') {
      return appendChxMotion(ctx, cc, { cmd: 'turn', axis, angle, frames: args.frames, rock: args.rock, wobble: args.wobble, wobbleAspect: args.wobbleAspect })
    }
    const cam = cameraOf(ctx, cc)
    if ('ok' in cam) return cam
    return setView(ctx, cc, { rotation: turnedRotation(cam.rotation, axis, angle) })
  },
})

const roll = chxCommand({
  words: ['roll'],
  args: [
    { name: 'axis', type: AxisArg, role: 'optional' },
    { name: 'angle', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'rock', type: StringArg, role: 'keyword' },
    { name: 'wobble', type: StringArg, role: 'keyword' },
    { name: 'wobbleAspect', type: StringArg, role: 'keyword' },
    ...MOTION_ARGS,
  ],
  mutates: false,
  summary: 'Keep turning the scene (default y, 1 degree a frame), as an animation that loops until stop.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('roll', args, MOTION_REFUSED, MOTION_WHY)
    if (refused) return refused
    const axis = motionAxis('roll', args.axis)
    if (!Array.isArray(axis)) return axis
    const angle = args.angle === '' ? 1 : Number(args.angle)
    return appendChxMotion(ctx, cc, { cmd: 'roll', axis, angle, frames: args.frames, rock: args.rock, wobble: args.wobble, wobbleAspect: args.wobbleAspect })
  },
})

const rock = chxCommand({
  words: ['rock'],
  args: [
    { name: 'axis', type: AxisArg, role: 'optional' },
    { name: 'angle', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'cycle', type: IntArg, role: 'keyword' },
    ...MOTION_ARGS,
  ],
  mutates: false,
  summary: 'Rock the scene back and forth (default y, 30 degrees, 136 frames a cycle), as an animation.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('rock', args, MOTION_REFUSED, MOTION_WHY)
    if (refused) return refused
    const axis = motionAxis('rock', args.axis)
    if (!Array.isArray(axis)) return axis
    const angle = args.angle === '' ? 30 : Number(args.angle)
    return appendChxMotion(ctx, cc, { cmd: 'rock', axis, angle, frames: args.frames, rock: args.cycle || '136', wobble: '', wobbleAspect: '' })
  },
})

const wobble = chxCommand({
  words: ['wobble'],
  args: [
    { name: 'axis', type: AxisArg, role: 'optional' },
    { name: 'angle', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'cycle', type: IntArg, role: 'keyword' },
    { name: 'aspect', type: FloatArg, role: 'keyword' },
    ...MOTION_ARGS,
  ],
  mutates: false,
  summary: 'Wobble the scene in a figure 8 (default y, 30 degrees, 136 frames a cycle, aspect 0.3), as an animation.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('wobble', args, MOTION_REFUSED, MOTION_WHY)
    if (refused) return refused
    const axis = motionAxis('wobble', args.axis)
    if (!Array.isArray(axis)) return axis
    const angle = args.angle === '' ? 30 : Number(args.angle)
    return appendChxMotion(ctx, cc, { cmd: 'wobble', axis, angle, frames: args.frames, rock: '', wobble: args.cycle || '136', wobbleAspect: args.aspect })
  },
})

const stop = chxCommand({
  words: ['stop'],
  args: [],
  mutates: false,
  summary: 'Stop the motion: pause the animation, and put back the loop setting a looping motion changed.',
  async run(ctx, _args, cc) {
    const ended = await stopConsoleLoop(ctx, cc, 'chx')
    if (!ended.ok) return ended
    if (!ended.ended && timelinePlaying(ctx, cc.sceneId)) {
      const paused = await runOp(ctx, cc, 'animate', { action: 'pause', timeMs: null })
      if (!paused.ok) return paused
    }
    return { ok: true }
  },
})

const move = chxCommand({
  words: ['move'],
  args: [
    { name: 'axis', type: AxisArg, role: 'required' },
    { name: 'distance', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'coordinateSystem', type: StringArg, role: 'keyword' },
    { name: 'models', type: StringArg, role: 'keyword' },
    { name: 'atoms', type: StringArg, role: 'keyword' },
  ],
  mutates: false,
  summary: 'Move the scene along a screen axis, in angstroms.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('move', args, ['coordinateSystem', 'models', 'atoms'], 'only the camera is moved')
    if (refused) return refused
    const axis = axisOf(args.axis)
    if (!axis) return { ok: false, error: `Error: move: "${args.axis}" is not an axis (x, y, z or three numbers)` }
    const frames = framesOf(args.frames)
    if (args.frames === 'forever') return unsupported('Error: move: frames forever is not supported (the console moves at once, not as an animation)')
    if (frames === null) return { ok: false, error: 'Error: move: frames must be a whole number' }
    if (args.frames !== '') cc.warn('move: frames: moved at once, not animated')
    // With no distance ChimeraX moves by the axis as given: 1 A along x.
    const d = (args.distance === '' ? 1 : Number(args.distance)) * frames
    const cam = cameraOf(ctx, cc)
    if ('ok' in cam) return cam
    // The camera moves by -d, so the scene appears to move by +d.
    const w = (k: 'x' | 'y' | 'z') => axis[0] * cam.right[k] + axis[1] * cam.up[k] + axis[2] * cam.back[k]
    return setView(ctx, cc, { center: [cam.center.x - d * w('x'), cam.center.y - d * w('y'), cam.center.z - d * w('z')] })
  },
})

// --- cofr / zoom ---

const cofr = chxCommand({
  words: ['cofr'],
  args: [
    // The spec first: it may be empty, so a method word still reaches `method`.
    { name: 'objects', type: SpecArg, role: 'optional' },
    { name: 'method', type: EnumOf(['frontCenter', 'fixed', 'centerOfView']), role: 'optional' },
    { name: 'pivot', type: StringArg, role: 'optional' },
    { name: 'coordinateSystem', type: StringArg, role: 'keyword' },
    { name: 'showPivot', type: StringArg, role: 'keyword' },
  ],
  mutates: false,
  summary: 'Report the centre of rotation (CueMol turns about the view centre).',
  run(ctx, args, cc) {
    if (args.objects !== '' || args.pivot !== '' || args.coordinateSystem !== '' || (args.method !== '' && args.method !== 'centerOfView')) {
      return {
        ok: false,
        error: 'Error: cofr: CueMol turns about the view centre, so moving the centre of rotation would move the view; use "view <spec>" to centre on something',
      }
    }
    if (args.showPivot !== '') cc.warn('cofr: showPivot is not supported yet; ignored')
    if (args.method !== '') return { ok: true }
    const cam = cameraOf(ctx, cc)
    if ('ok' in cam) return cam
    cc.print(`Center of rotation: ${g5(cam.center.x)} ${g5(cam.center.y)} ${g5(cam.center.z)}  center of view`)
    return { ok: true }
  },
})

const zoom = chxCommand({
  words: ['zoom'],
  args: [
    { name: 'factor', type: FloatArg, role: 'optional' },
    { name: 'frames', type: StringArg, role: 'optional' },
    { name: 'pixelSize', type: FloatArg, role: 'keyword' },
  ],
  mutates: false,
  summary: 'Zoom by a factor, or to a pixel size in angstroms; alone, report the pixel size.',
  async run(ctx, args, cc) {
    const cam = cameraOf(ctx, cc)
    if ('ok' in cam) return cam
    if (args.factor === '' && args.pixelSize === '') {
      cc.print(`Pixel size at center of rotation is ${Number(pixelSize(cam).toPrecision(3))}`)
      return { ok: true }
    }
    // ChimeraX reaches the factor over all the frames, so it is not multiplied.
    if (args.frames !== '') cc.warn('zoom: frames: zoomed at once, not animated')
    let factor = args.factor === '' ? 1 : Number(args.factor)
    if (args.pixelSize !== '') factor *= pixelSize(cam) / Number(args.pixelSize)
    if (!(factor > 0)) return { ok: false, error: 'Error: zoom: the factor must be positive' }
    return setView(ctx, cc, { zoom: cam.zoom / factor })
  },
})

// --- Named views and view matrix ---

/** Names a view cannot have (ChimeraX `view_name`): its options, or a prefix of one. */
const RESERVED_VIEW_NAMES = ['clip', 'cofr', 'delete', 'frames', 'initial', 'list', 'matrix', 'orient', 'zalign', 'pad', 'position']

/** The scene's saved cameras, by name. */
async function cameraNames(ctx: WorkerContext, cc: CmdContext): Promise<string[]> {
  const res = await runOp(ctx, cc, 'list_cameras', {})
  if (!res.ok) return []
  return (res.data as { cameras: { name: string }[] }).cameras.map((c) => c.name)
}

const viewList = chxCommand({
  words: ['view', 'list'],
  args: [],
  mutates: false,
  summary: 'List the named views.',
  async run(ctx, _args, cc) {
    const names = (await cameraNames(ctx, cc)).sort()
    cc.print(names.length > 0 ? `Named views: ${names.join(', ')}` : 'No named views.')
    return { ok: true }
  },
})

const viewDelete = chxCommand({
  words: ['view', 'delete'],
  args: [{ name: 'name', type: StringArg, role: 'required' }],
  mutates: true,
  summary: 'Delete a named view, or all of them.',
  async run(ctx, args, cc) {
    const names = args.name === 'all' ? await cameraNames(ctx, cc) : [args.name]
    for (const name of names) {
      const res = await runOp(ctx, cc, 'delete_camera', { name })
      // ChimeraX says nothing about a name it does not have.
      if (!res.ok && args.name === 'all') return res
    }
    return { ok: true }
  },
})

const viewName = chxCommand({
  words: ['view', 'name'],
  args: [{ name: 'name', type: StringArg, role: 'required' }],
  mutates: true,
  summary: 'Save the camera under a name (the camera only: the console does not move models).',
  async run(ctx, args, cc) {
    const clash = RESERVED_VIEW_NAMES.find((r) => r.startsWith(args.name))
    if (clash) {
      return { ok: false, error: `Error: view name "${args.name}" conflicts with "${clash}" view option` }
    }
    const res = await runOp(ctx, cc, 'save_camera', { name: args.name, withVisibility: null })
    return res.ok ? { ok: true } : res
  },
})

const viewMatrix = chxCommand({
  words: ['view', 'matrix'],
  args: [
    { name: 'camera', type: StringArg, role: 'keyword' },
    { name: 'models', type: StringArg, role: 'keyword' },
    { name: 'coordinateSystem', type: StringArg, role: 'keyword' },
  ],
  mutates: false,
  summary: 'Set the camera from 12 numbers (a 3x4 matrix by rows), or report it.',
  async run(ctx, args, cc) {
    const refused = refuseGiven('view matrix', args, ['models', 'coordinateSystem'], 'the console does not move models')
    if (refused) return refused
    const cam = cameraOf(ctx, cc)
    if ('ok' in cam) return cam
    if (args.camera === '') {
      cc.print(`view matrix camera ${cameraMatrix(cam).map(g5).join(',')}`)
      return { ok: true }
    }
    const m = args.camera.split(',').map(Number)
    if (m.length !== 12 || !m.every(Number.isFinite)) return { ok: false, error: 'Error: view matrix: camera takes 12 numbers' }
    // ChimeraX's camera has a position only; CueMol's turns about a centre at
    // `distance` in front of the eye, and draws a slab about it. The centre
    // goes where the line of sight passes the middle of what is shown, so the
    // scene stays inside the slab; the slab is then fitted to it.
    const back = { x: m[2], y: m[6], z: m[10] }
    const bl = Math.hypot(back.x, back.y, back.z) || 1
    const all = targetsOf(ctx, cc.sceneId, '')
    const framing = all.ok ? framingOf(ctx, cc.sceneId, cc.viewId, all.targets) : null
    let distance = cam.distance
    if (framing) {
      const ahead = -((framing.center[0] - m[3]) * back.x + (framing.center[1] - m[7]) * back.y + (framing.center[2] - m[11]) * back.z) / bl
      // A camera looking away from the scene keeps the distance it had.
      if (ahead > 0) distance = ahead
    }
    const placed = cameraFromMatrix(m, distance, cam.width / Math.max(1, cam.height))
    const set = await setView(ctx, cc, { rotation: placed.rotation, center: placed.center, zoom: placed.zoom, distance })
    if (!set.ok) return set
    const slab = await setView(ctx, cc, { fitSlab: true })
    if (!slab.ok) return slab
    // ChimeraX's camera is a perspective one; CueMol's defaults to orthographic.
    const proj = await runOp(ctx, cc, 'set_projection', { perspective: true })
    return proj.ok ? { ok: true } : proj
  },
})

/** `view <name>`: recall a named view when the word is one (called by `view`). */
export async function recallView(ctx: WorkerContext, cc: CmdContext, name: string): Promise<CmdOutcome | null> {
  if (!(await cameraNames(ctx, cc)).includes(name)) return null
  const res = await runOp(ctx, cc, 'apply_camera', { name, withVisibility: null })
  return res.ok ? { ok: true } : res
}

// --- set / graphics silhouettes ---

/** Renderer types that draw no faces, so have no outline (the Inspector's `NO_EDGE_LINE_TYPES`). */
const NO_EDGE_TYPES = new Set(['simple', 'trace', 'spline', 'contour', 'gpu_mapmesh', '*selection', '*unitcell', '*namelabel'])

/** Every renderer in the scene that can draw an outline, with its edge settings. */
function outlinedRenderers(ctx: WorkerContext, sceneId: number): { id: number; objUid: number; egtype: string; eglinew: number; egcolor: string }[] {
  const out: { id: number; objUid: number; egtype: string; eglinew: number; egcolor: string }[] = []
  for (const obj of objectNodes(ctx, sceneId)) {
    for (const r of rendererNodesOf(obj).filter((n) => n.type === 'renderer')) {
      const props = getGenericProps(ctx, { sceneId, nodeId: r.id, nodeType: 'renderer' })
      if (!props.ok) continue
      const get = (k: string) => props.entries.find((e) => e.key === k)?.value
      if (get('egtype') === undefined || NO_EDGE_TYPES.has(String(get('type_name')))) continue
      out.push({ id: r.id, objUid: obj.id, egtype: String(get('egtype')), eglinew: Number(get('eglinew')), egcolor: String(get('egcolor')) })
    }
  }
  return out
}

/**
 * The outline mode ChimeraX's silhouettes are: CueMol's `edges` inks every
 * boundary where the depth jumps (an atom in front of another too), as
 * ChimeraX does; its `silhouette` inks only the outer contour.
 */
const SILHOUETTE_EDGE_TYPE = 'edges'

/** ChimeraX's default silhouette width in pixels (`graphics/opengl.py` `Silhouette.thickness`). */
const SILHOUETTE_DEFAULT_PX = 1

/**
 * ChimeraX's silhouettes, which are one setting for the whole view, as the
 * outline of every renderer that can draw one, in the `edges` mode
 * (`SILHOUETTE_EDGE_TYPE`). The width is in pixels there and in angstroms
 * here, so it is converted at the current zoom. An outline in either mode
 * counts as on.
 */
export async function silhouettes(
  ctx: WorkerContext,
  cc: CmdContext,
  cmd: string,
  enable: string,
  width: string,
  color: string,
): Promise<CmdOutcome> {
  const rends = outlinedRenderers(ctx, cc.sceneId)
  const cam = cameraOf(ctx, cc)
  if ('ok' in cam) return cam
  if (enable === '' && width === '' && color === '') {
    const on = rends.some((r) => r.egtype !== 'none')
    const first = rends.find((r) => r.egtype !== 'none') ?? rends[0]
    const px = first ? first.eglinew / pixelSize(cam) : 0
    cc.print(`Silhouettes: ${on}, width ${Number(px.toPrecision(3))}, color ${first?.egcolor ?? ''}`)
    return { ok: true }
  }
  if (width !== '') cc.warn(`${cmd}: the width is converted at the current zoom (CueMol's outline width is in angstroms, so it grows as you zoom in)`)
  for (const r of rends) {
    const writes: [string, string][] = []
    if (enable !== '') writes.push(['egtype', enable === 'true' ? SILHOUETTE_EDGE_TYPE : 'none'])
    if (width !== '') writes.push(['eglinew', String(Number(width) * pixelSize(cam))])
    // An outline turned on gets ChimeraX's default width, 1 pixel at the
    // current zoom: CueMol's default (0.01 A) is a fraction of a pixel. An
    // outline already on keeps the width it has.
    else if (enable === 'true' && r.egtype === 'none') writes.push(['eglinew', String(SILHOUETTE_DEFAULT_PX * pixelSize(cam))])
    if (color !== '') writes.push(['egcolor', splitColorArg(color).hex])
    for (const [prop, value] of writes) {
      const res = await runOp(ctx, cc, 'set_node_prop', { nodeType: 'renderer', nodeId: r.id, prop, value })
      if (!res.ok) return res
    }
  }
  return { ok: true }
}

/**
 * Keep the silhouettes as wide in pixels as they were before the camera
 * moved: ChimeraX's width is in pixels, CueMol's in angstroms, so a zoom
 * would widen them (`view` on a few residues, tens of times). The `edges`
 * outlines are scaled by how much the pixel size changed.
 *
 * @param before - the camera before the command ran
 */
export async function keepSilhouettePixels(ctx: WorkerContext, cc: CmdContext, before: CameraState): Promise<CmdOutcome> {
  const after = readCamera(ctx, cc.viewId)
  if (!after) return { ok: true }
  const ratio = pixelSize(after) / pixelSize(before)
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-6) return { ok: true }
  for (const r of outlinedRenderers(ctx, cc.sceneId).filter((o) => o.egtype === SILHOUETTE_EDGE_TYPE)) {
    const res = await runOp(ctx, cc, 'set_node_prop', { nodeType: 'renderer', nodeId: r.id, prop: 'eglinew', value: String(r.eglinew * ratio) })
    if (!res.ok) return res
  }
  return { ok: true }
}

/**
 * A command that keeps the silhouettes' pixel width (`keepSilhouettePixels`)
 * across whatever it does to the camera. Only the outermost command does
 * it: an alias or a preset runs commands inside its own.
 */
let keeping = 0
export function keepingSilhouettes(c: ChxCommand): ChxCommand {
  return {
    ...c,
    async run(ctx, args, cc) {
      if (keeping > 0) return c.run(ctx, args, cc)
      keeping++
      try {
        const before = readCamera(ctx, cc.viewId)
        const out = await c.run(ctx, args, cc)
        if (!before) return out
        const kept = await keepSilhouettePixels(ctx, cc, before)
        return kept.ok ? out : kept
      } finally {
        keeping--
      }
    },
  }
}

/**
 * Give renderers just made the outline the rest of the scene has: ChimeraX's
 * silhouettes are one setting for the view, so a model opened after they
 * were turned on is outlined too. Read from the scene's renderers (one in
 * the `edges` mode), not kept aside, so a saved scene behaves the same.
 *
 * @param isNew - which renderers were just made (by renderer id, or by their object's uid)
 */
export async function inheritSilhouettes(
  ctx: WorkerContext,
  cc: CmdContext,
  isNew: (r: { id: number; objUid: number }) => boolean,
): Promise<CmdOutcome> {
  const rends = outlinedRenderers(ctx, cc.sceneId)
  const model = rends.find((r) => !isNew(r) && r.egtype === SILHOUETTE_EDGE_TYPE)
  if (!model) return { ok: true }
  for (const r of rends.filter(isNew)) {
    const writes: [string, string][] = []
    if (r.egtype !== model.egtype) writes.push(['egtype', model.egtype])
    if (r.eglinew !== model.eglinew) writes.push(['eglinew', String(model.eglinew)])
    if (r.egcolor !== model.egcolor) writes.push(['egcolor', model.egcolor])
    for (const [prop, value] of writes) {
      const res = await runOp(ctx, cc, 'set_node_prop', { nodeType: 'renderer', nodeId: r.id, prop, value })
      if (!res.ok) return res
    }
  }
  return { ok: true }
}

const graphicsSilhouettes = chxCommand({
  words: ['graphics', 'silhouettes'],
  args: [
    { name: 'enable', type: BoolArg, role: 'optional' },
    { name: 'width', type: FloatArg, role: 'keyword' },
    { name: 'color', type: ColorArg, role: 'keyword' },
    { name: 'depthJump', type: FloatArg, role: 'keyword', ignored: true },
  ],
  mutates: true,
  summary: 'Outline what is drawn (silhouette edges), or report the setting.',
  async run(ctx, args, cc) {
    if (args.depthJump !== '') cc.warn('graphics silhouettes: depthJump is not supported yet; ignored')
    return silhouettes(ctx, cc, 'graphics silhouettes', args.enable, args.width, args.color)
  },
})

/** The scene's background colour, as `set` / `graphics` report it. */
function reportBackground(ctx: WorkerContext, cc: CmdContext): CmdOutcome {
  const props = getGenericProps(ctx, { sceneId: cc.sceneId, nodeId: cc.sceneId, nodeType: 'scene' })
  const bg = props.ok ? props.entries.find((e) => e.key === 'bgcolor')?.value : undefined
  cc.print(`Background color: ${String(bg ?? '')}`)
  return { ok: true }
}

/** Set the scene's background colour. */
function setBackground(ctx: WorkerContext, cc: CmdContext, color: string) {
  return runOp(ctx, cc, 'set_node_prop', { nodeType: 'scene', nodeId: null, prop: 'bgcolor', value: splitColorArg(color).hex })
}

/**
 * `graphics [bgColor c]` (`std_commands/graphics.py`; `backgroundColor` is
 * its older name): the background colour, as `set bgColor`; alone, report it.
 */
const graphics = chxCommand({
  words: ['graphics'],
  args: [
    { name: 'bgColor', type: ColorArg, role: 'keyword' },
    { name: 'backgroundColor', type: ColorArg, role: 'keyword' },
  ],
  mutates: true,
  summary: 'Set the background colour; alone, report it.',
  async run(ctx, args, cc) {
    const color = args.bgColor !== '' ? args.bgColor : args.backgroundColor
    if (color === '') return reportBackground(ctx, cc)
    const res = await setBackground(ctx, cc, color)
    return res.ok ? { ok: true } : res
  },
})

/** `wait [frames]`: the console applies each command at once, so there is nothing to wait for. */
const wait = chxCommand({
  words: ['wait'],
  args: [{ name: 'frames', type: StringArg, role: 'optional' }],
  mutates: false,
  summary: 'Wait for motions to finish (nothing to do: the console applies each command at once).',
  run: () => ({ ok: true }),
})

const set = chxCommand({
  words: ['set'],
  args: [
    { name: 'bgColor', type: ColorArg, role: 'keyword' },
    { name: 'silhouettes', type: BoolArg, role: 'keyword' },
    { name: 'silhouetteWidth', type: FloatArg, role: 'keyword' },
    { name: 'silhouetteColor', type: ColorArg, role: 'keyword' },
    { name: 'silhouetteDepthJump', type: FloatArg, role: 'keyword', ignored: true },
    { name: 'subdivision', type: StringArg, role: 'keyword', ignored: true },
    { name: 'maxFrameRate', type: StringArg, role: 'keyword', ignored: true },
    { name: 'selectionColor', type: StringArg, role: 'keyword', ignored: true },
    { name: 'selectionWidth', type: StringArg, role: 'keyword', ignored: true },
  ],
  mutates: true,
  summary: 'Set the background colour (and the silhouettes); alone, report the background.',
  async run(ctx, args, cc) {
    for (const k of ['silhouetteDepthJump', 'subdivision', 'maxFrameRate', 'selectionColor', 'selectionWidth']) {
      if (args[k] !== '') cc.warn(`set: ${k} is not supported yet; ignored`)
    }
    const any = Object.values(args).some((v) => v !== '')
    if (!any) return reportBackground(ctx, cc)
    if (args.bgColor !== '') {
      const res = await setBackground(ctx, cc, args.bgColor)
      if (!res.ok) return res
    }
    if (args.silhouettes !== '' || args.silhouetteWidth !== '' || args.silhouetteColor !== '') {
      return silhouettes(ctx, cc, 'set', args.silhouettes, args.silhouetteWidth, args.silhouetteColor)
    }
    return { ok: true }
  },
})

export const VIEW_COMMANDS: Record<string, ChxCommand> = {
  turn,
  roll,
  rock,
  wobble,
  stop,
  move,
  cofr,
  zoom,
  viewList,
  viewDelete,
  viewName,
  viewMatrix,
  graphics,
  graphicsSilhouettes,
  set,
  wait,
}
