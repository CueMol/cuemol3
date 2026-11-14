/**
 * @file plugins/console/worker/runtime/motion.ts
 * @description Camera motions a dialect turns into animation elements
 * (ChimeraX `turn` / `roll` / `rock` / `wobble`, PyMOL `movie.*` / `rock`),
 * and the loop a "forever" motion borrows.
 *
 * A motion is appended to the scene's timeline through the ops (`add_anim`,
 * `set_anim_time`, `set_anim_prop`), so it is undoable, recorded and the
 * same element the Animation panel makes.
 *
 * A motion that runs until stopped (ChimeraX `rock` with no frame count,
 * PyMOL `rock`) is one cycle played in a loop. The loop setting is the
 * scene's own, so the console keeps one record per scene of the value it
 * found, shared by every dialect:
 *   - the first console start saves the current loop value and turns loop on;
 *     a further start keeps the saved value (so start, start, stop still
 *     ends where the scene began);
 *   - a console stop puts the saved value back and drops the record -- unless
 *     loop was switched off meanwhile (the person's choice), in which case
 *     only the record goes;
 *   - a stop from the Animation panel does not touch loop.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver'
import { getAnimMgrOrNull } from '@renderer/worker/server/services/anim/resolve'
import { readMgrState } from '@renderer/worker/server/services/anim/read'
import type { CmdContext } from './types'
import { runOp, type OpRun } from './opContext'

/** One element to append: its `add_anim` type, length and properties (op text values). */
export interface MotionElement {
  type: 'spin' | 'rock'
  durationMs: number
  props: Readonly<Record<string, string>>
}

/** Loop value found when the console first started a looping motion, per scene. */
const savedLoop = new Map<number, boolean>()

/** The scene's manager state, or null without one. */
function mgrState(ctx: WorkerContext, sceneId: number): { loop: boolean; playing: boolean; size: number } | null {
  const scene = getSceneOrNull(ctx, sceneId)
  const mgr = scene ? getAnimMgrOrNull(scene) : null
  if (!mgr) return null
  const s = readMgrState(mgr)
  let size = 0
  try {
    size = mgr.size
  } catch {
    size = 0
  }
  return { loop: s.loop, playing: s.playState === 'play', size }
}

/** How many elements the scene's timeline has (0 without a manager). */
export function timelineSize(ctx: WorkerContext, sceneId: number): number {
  return mgrState(ctx, sceneId)?.size ?? 0
}

/** Whether the scene's timeline is playing. */
export function timelinePlaying(ctx: WorkerContext, sceneId: number): boolean {
  return mgrState(ctx, sceneId)?.playing ?? false
}

/** The timeline's length in ms (0 without a manager). */
export function timelineLengthMs(ctx: WorkerContext, sceneId: number): number {
  const scene = getSceneOrNull(ctx, sceneId)
  const mgr = scene ? getAnimMgrOrNull(scene) : null
  return mgr ? readMgrState(mgr).lengthMs : 0
}

/**
 * Append the elements in order; each follows the one before it.
 *
 * @param tag - the dialect's op tag (`chx`, `pym`).
 */
export async function appendMotion(
  ctx: WorkerContext,
  cc: CmdContext,
  tag: string,
  elements: readonly MotionElement[],
): Promise<OpRun> {
  for (const el of elements) {
    const added = await runOp(ctx, cc, tag, 'add_anim', { type: el.type, name: null, before: null })
    if (!added.ok) return added
    const element = `#${(added.data as { uid: number }).uid}`
    const timed = await runOp(ctx, cc, tag, 'set_anim_time', { element, startMs: 0, endMs: Math.max(1, Math.round(el.durationMs)) })
    if (!timed.ok) return timed
    // pattern first: it re-seeds aspect, which a later prop may override.
    const keys = Object.keys(el.props).sort((a, b) => (a === 'pattern' ? -1 : b === 'pattern' ? 1 : 0))
    for (const prop of keys) {
      const set = await runOp(ctx, cc, tag, 'set_anim_prop', { element, prop, value: el.props[prop] })
      if (!set.ok) return set
    }
  }
  return { ok: true }
}

/**
 * Play the timeline from `ms` (where a just-appended motion starts), so a
 * motion runs when its command is given, as in ChimeraX.
 */
export async function playFrom(ctx: WorkerContext, cc: CmdContext, tag: string, ms: number): Promise<OpRun> {
  const seek = await runOp(ctx, cc, tag, 'animate', { action: 'seek', timeMs: ms })
  if (!seek.ok) return seek
  return runOp(ctx, cc, tag, 'animate', { action: 'play', timeMs: null })
}

/**
 * Whether a console-started looping motion is running in the scene: there is
 * a saved loop value and the timeline is actually playing.
 */
export function consoleMotionRunning(ctx: WorkerContext, sceneId: number): boolean {
  return savedLoop.has(sceneId) && (mgrState(ctx, sceneId)?.playing ?? false)
}

/** Whether the console holds a saved loop value for the scene. */
export function consoleMotionRecorded(sceneId: number): boolean {
  return savedLoop.has(sceneId)
}

/** Turn loop on (saving the scene's value the first time) and play from where it is. */
export async function startConsoleLoop(ctx: WorkerContext, cc: CmdContext, tag: string): Promise<OpRun> {
  const st = mgrState(ctx, cc.sceneId)
  if (!st) return { ok: false, error: 'Error: the scene has no animation' }
  if (!savedLoop.has(cc.sceneId)) savedLoop.set(cc.sceneId, st.loop)
  if (!st.loop) {
    const looped = await runOp(ctx, cc, tag, 'set_anim_options', { loop: true, startCamera: null })
    if (!looped.ok) return looped
  }
  if (st.playing) return { ok: true }
  return runOp(ctx, cc, tag, 'animate', { action: 'play', timeMs: null })
}

/**
 * End a console-started looping motion: pause if playing, and put the saved
 * loop value back (see the file header). Does nothing without a record.
 *
 * @returns whether there was a record to end.
 */
export async function stopConsoleLoop(ctx: WorkerContext, cc: CmdContext, tag: string): Promise<{ ok: true; ended: boolean } | { ok: false; error: string }> {
  if (!savedLoop.has(cc.sceneId)) return { ok: true, ended: false }
  const saved = savedLoop.get(cc.sceneId) as boolean
  savedLoop.delete(cc.sceneId)
  const st = mgrState(ctx, cc.sceneId)
  if (!st) return { ok: true, ended: true }
  if (st.playing) {
    const paused = await runOp(ctx, cc, tag, 'animate', { action: 'pause', timeMs: null })
    if (!paused.ok) return paused
  }
  // Loop off now means the person switched it off: keep their choice.
  if (st.loop && st.loop !== saved) {
    const restored = await runOp(ctx, cc, tag, 'set_anim_options', { loop: saved, startCamera: null })
    if (!restored.ok) return restored
  }
  return { ok: true, ended: true }
}

/** Forget every saved loop value (tests). */
export function resetConsoleMotion(): void {
  savedLoop.clear()
}
