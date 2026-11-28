/**
 * @file plugins/pymol-console/worker/commands/trajCommands.ts
 * @description `load_traj`: reading MD trajectory frames into a molecule, as
 * PyMOL's `load_traj` (importing.py) does, through the MD Tools op
 * `add_traj_block`.
 *
 * PyMOL appends the frames to an object loaded from a topology as states.
 * Here they become blocks of a Trajectory; a plain molecule is converted into
 * one. PyMOL's `state` maps onto the op's `replace`: the default state 1
 * fills from the first state, which replaces the frames (and a topology's own
 * coordinates), while state 0 appends after the last. `interval` is the
 * op's `nevery`, and `selection` its load selection. The frame range
 * (`start` / `stop` / `max`) and the Amber image options have no counterpart
 * and are ignored with a warning.
 *
 * `load` sends a trajectory file here too (`TRAJ_EXTS`), as PyMOL's `load`
 * appends a DCD to the latest object.
 */

import * as fs from 'fs'
import * as path from 'path'
import { isMoleculeClass } from '@renderer/worker/shared/objectClasses'
import { listSceneObjects } from '@renderer/worker/server/services/scene/listSceneObjects'
import type { CmdContext, CmdOutcome, PymCommand } from './types'
import { fileStem, isAllSelection, isDefaulted, resolveOneObject, resolvePath, runOp } from './helpers'
import { translateSelection } from '../sel/translate'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'

/** The op `load_traj` runs (MD Tools plugin). */
const ADD_TRAJ_BLOCK = 'add_traj_block'

/**
 * PyMOL's trajectory format names (`format=`), and the file extensions, as the
 * MD Tools block reader each one means. Only what both programs read.
 */
const TRAJ_FORMATS: Readonly<Record<string, string>> = {
  dcd: 'dcdtraj',
  xtc: 'xtctraj',
  trr: 'trrtraj',
  nc: 'ambnetcdftraj',
  netcdf: 'ambnetcdftraj',
  rst: 'amberrst',
  rst7: 'amberrst',
  inpcrd: 'amberrst',
  restrt: 'amberrst',
  coor: 'namdcoortraj',
  namdbin: 'namdcoortraj',
}

/** The extensions `load` hands to `load_traj` (frames, which need a molecule). */
export const TRAJ_EXTS: ReadonlySet<string> = new Set(['dcd', 'xtc', 'trr', 'nc', 'rst7', 'inpcrd', 'restrt', 'coor'])

/** Whether `load` should read this file as trajectory frames. */
export function isTrajFile(filePath: string): boolean {
  return TRAJ_EXTS.has(path.extname(filePath).slice(1).toLowerCase())
}

/** `load_traj`'s arguments with no counterpart here, with PyMOL's defaults. */
const IGNORED: ReadonlyArray<[string, string]> = [
  ['average', '1'],
  ['start', '1'],
  ['stop', '-1'],
  ['image', '1'],
  ['shift', '[0.0,0.0,0.0]'],
  ['plugin', ''],
]

/**
 * The molecule the frames go to: the one named, else the one named after the
 * file, else the latest one added (PyMOL's `_guess_trajectory_object`).
 */
function targetMolecule(
  ctx: WorkerContext,
  sceneId: number,
  object: string,
  filePath: string,
): { ok: true; objId: number; name: string } | { ok: false; error: string } {
  if (object !== '') {
    const one = resolveOneObject(ctx, sceneId, object)
    if (!one.ok) return one
    if (!isMoleculeClass(one.obj.className)) return { ok: false, error: `Error: "${object}" is not a molecule` }
    return { ok: true, objId: one.obj.uid, name: one.obj.name }
  }
  const mols = listSceneObjects(ctx, { sceneId }).objects.filter((o) => isMoleculeClass(o.className) && o.className !== 'MorphMol')
  const stem = fileStem(filePath)
  const named = mols.find((o) => o.name === stem)
  // Uids grow as objects are made, so the largest is the latest.
  const latest = named ?? mols.reduce<(typeof mols)[number] | undefined>((a, o) => (a === undefined || o.uid > a.uid ? o : a), undefined)
  if (!latest) return { ok: false, error: 'Error: no molecule to load the trajectory into; load its topology first' }
  return { ok: true, objId: latest.uid, name: latest.name }
}

/**
 * Read trajectory frames into a molecule.
 *
 * @param args - `load_traj`'s arguments by name; `load` passes its own
 *   filename, object and format with the rest left at PyMOL's defaults
 */
export async function loadTrajInto(ctx: WorkerContext, args: Record<string, string>, cc: CmdContext): Promise<CmdOutcome> {
  for (const [name, def] of IGNORED) {
    if (!isDefaulted(args[name], def)) cc.warn(`load_traj: ${name} is ignored (not supported)`)
  }
  const max = (args.max ?? '-1').trim()
  if (max !== '-1' && max !== '0') cc.warn('load_traj: max is ignored (not supported)')

  const filePath = resolvePath(cc.cwd, args.filename)
  if (!fs.existsSync(filePath)) return { ok: false, error: `Error: no such file: ${filePath}` }

  const format = (args.format ?? '').trim().toLowerCase()
  const reader = format === '' ? null : TRAJ_FORMATS[format]
  if (reader === undefined) {
    return { ok: false, error: `Error: unknown trajectory format "${args.format}" (one of ${Object.keys(TRAJ_FORMATS).join(', ')})` }
  }
  if (reader === null && !isTrajFile(filePath)) {
    return { ok: false, error: `Error: ${path.basename(filePath)} is not a trajectory file this console reads; give format=<format>` }
  }

  const state = Number((args.state ?? '1').trim())
  if (state !== 0 && state !== 1) cc.warn(`load_traj: state ${args.state} is read as 0 (appended after the last state)`)
  const interval = Number((args.interval ?? '1').trim())
  if (!Number.isInteger(interval) || interval < 1) return { ok: false, error: `Error: interval must be a whole number of 1 or more` }

  const target = targetMolecule(ctx, cc.sceneId, args.object ?? '', filePath)
  if (!target.ok) return target

  // A PyMOL selection, as CueMol reads it inside this molecule (an object
  // name is all of it or none, as moleculeSelections does).
  let loadSel: string | null = null
  if (!isAllSelection(args.selection ?? '')) {
    const molNames = new Set(listSceneObjects(ctx, { sceneId: cc.sceneId }).objects.map((o) => o.name))
    const translated = translateSelection(args.selection, (n) =>
      n === target.name ? 'all' : molNames.has(n) ? 'none' : undefined)
    if (!translated.ok) return translated
    loadSel = translated.expr
  }

  const res = await runOp(ctx, cc, ADD_TRAJ_BLOCK, {
    objId: target.objId,
    paths: [filePath],
    reader,
    nevery: interval > 1 ? interval : null,
    loadSel,
    replace: state === 1 ? true : null,
  })
  if (!res.ok) return { ok: false, error: `Error: could not load ${filePath}: ${res.error.replace(/^Error: /, '')}` }
  const nframe = (res.data as { nframe?: number } | undefined)?.nframe
  cc.print(` load_traj: "${filePath}" loaded into "${target.name}"${typeof nframe === 'number' ? ` (${nframe} states)` : ''}.`)
  return { ok: true }
}

const loadTraj: PymCommand = {
  name: 'load_traj',
  params: [
    { name: 'filename' },
    { name: 'object', default: '' },
    { name: 'state', default: '1' },
    { name: 'format', default: '' },
    { name: 'interval', default: '1' },
    { name: 'average', default: '1' },
    { name: 'start', default: '1' },
    { name: 'stop', default: '-1' },
    { name: 'max', default: '-1' },
    { name: 'selection', default: 'all' },
    { name: 'image', default: '1' },
    { name: 'shift', default: '[0.0,0.0,0.0]' },
    { name: 'plugin', default: '' },
  ],
  mode: 'strict',
  mutates: true,
  summary: 'Read MD trajectory frames (.dcd .xtc .trr .nc, restarts) into a molecule loaded from its topology.',
  completions: [
    { source: 'files', description: 'file', suffix: ', ' },
    { source: 'objects', description: 'object', suffix: ', ' },
  ],
  run(ctx, args, cc) {
    return loadTrajInto(ctx, args, cc)
  },
}

export const TRAJ_COMMANDS: PymCommand[] = [loadTraj]
