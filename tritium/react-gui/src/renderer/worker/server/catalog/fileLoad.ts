/**
 * @file worker/server/catalog/fileLoad.ts
 * @description Loading a file the way File > Open does, for the load ops.
 *
 * The reader is picked by the rule the GUI uses (`shared/openFileKind.ts`):
 * a scene file opens as a scene; an object file's extension decides its
 * reader when exactly one reader claims it, and its content otherwise. The
 * load then follows `OpenObjByPath`: the reader's own defaults for the
 * options (what the option dialog starts with), then `loadObject` with that
 * reader. `load_file` takes the defaults as they are.
 *
 * A format's own load op (`load_pdb`, `load_ccp4`, ...) does not pick: it
 * reads with its one reader (`readerTarget`), changing the options it was
 * given first, and fails when that reader cannot read the file.
 */

import { getCompatibleRendererNames } from '@renderer/worker/server/services/file/getCompatibleRendererNames'
import { getOpenFilters } from '@renderer/worker/server/services/file/getOpenFilters'
import { buildHeadlessFileOpenOptions } from '@renderer/worker/server/services/file/headlessOpen'
import { loadObject } from '@renderer/worker/server/services/file/loadObject'
import { defaultRendererName, type RendNameScope } from '@renderer/worker/server/services/rend/defaultRendererName'
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver'
import { OBJREADER_CATEGORY } from '@renderer/worker/server/services/helpers/pickReaderName'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import type { FormatOptions, MapCenterPolicy, RendererOptions } from '@renderer/worker/shared/fileOpenTypes'
import { normalizeServiceResult } from '@renderer/worker/shared/serviceResult'
import { fileStem } from '@shared/fileExt'
import { classifyOpenFile } from '@shared/openFileKind'
import type { OpContext, OpOutcome } from './op'
import { callerPath } from './outputFile'
import { boolean, enumOf, optional, string } from './params'

/** InOutHandler::IOH_CAT_SCEREADER. */
const SCENE_READER_CATEGORY = 3

/** A scene file, by the one scene reader's extension; for `outsideTxn`, which is asked before any reader is. */
export const SCENE_FILE_RE = /\.qsc$/i

/** What a path opens as: a scene, or an object with the reader the GUI would pick. */
export type OpenTarget = { scene: true; filePath: string } | { scene: false; filePath: string; readerName: string; contentFirst: boolean }

/** A path as a caller gave it, resolved, and how its extension classifies it. */
interface LoadPath {
  filePath: string
  kind: ReturnType<typeof classifyOpenFile>
}

/** Resolve `raw` and classify it by extension alone (no reader is asked). */
function classifyLoadPath(ctx: WorkerContext, raw: string): LoadPath {
  const filePath = callerPath(raw)
  const kind = classifyOpenFile(
    filePath,
    getOpenFilters(ctx, { catId: OBJREADER_CATEGORY }),
    getOpenFilters(ctx, { catId: SCENE_READER_CATEGORY }),
  )
  return { filePath, kind }
}

/**
 * Where `raw` (as a caller gave it) opens. A file no reader claims by
 * extension is sniffed, as File > Open does with "All Files".
 *
 * @returns the target, or why none
 */
export function openTarget(ctx: WorkerContext, raw: string): OpenTarget | { error: string } {
  const { filePath, kind } = classifyLoadPath(ctx, raw)
  if (kind.kind === 'scene') return { scene: true, filePath }
  // Claimed by no reader at all: let the content decide, as File > Open does.
  const contentFirst = kind.kind === 'unsupported' ? true : kind.contentFirst
  const readerName = getCompatibleRendererNames(ctx, { filePath, contentFirst }).readerName
  if (!readerName) {
    // A trajectory reader's extension, kept out of the open filters (a DCD file has no content sniff).
    if (trajectoryExtension(ctx, filePath)) return { error: trajectoryFramesError(filePath) }
    return { error: `No reader can handle "${filePath}". Check the path and the format.` }
  }
  return { scene: false, filePath, readerName, contentFirst }
}

/** A path of an object reader's extension that only the trajectory (TrajBlock) readers claim. */
function trajectoryExtension(ctx: WorkerContext, filePath: string): boolean {
  const ext = filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  if (!ext) return false
  const withTraj = getOpenFilters(ctx, { catId: OBJREADER_CATEGORY, includeTrajReaders: true })[0]?.extensions ?? []
  const without = getOpenFilters(ctx, { catId: OBJREADER_CATEGORY })[0]?.extensions ?? []
  return withTraj.includes(ext) && !without.includes(ext)
}

/**
 * Why a load refuses a file of MD trajectory frames: they belong to a
 * molecule (a topology), so they open through the MD Tools ops.
 */
function trajectoryFramesError(filePath: string): string {
  return (
    `"${filePath}" holds MD trajectory frames, which cannot be opened on their own. ` +
    'Open them with their topology (load_trajectory <topology>, <files>), or add them to a molecule ' +
    'already open (add_traj_block <molecule>, <files>).'
  )
}

/**
 * Where `raw` opens with a format's load op: always `readerName`, never a
 * sniffed reader, so a file that reader cannot read fails in the reader. A
 * scene file (by extension) is still a scene, which a format op refuses.
 */
export function readerTarget(ctx: WorkerContext, raw: string, readerName: string): OpenTarget {
  const { filePath, kind } = classifyLoadPath(ctx, raw)
  if (kind.kind === 'scene') return { scene: true, filePath }
  return { scene: false, filePath, readerName, contentFirst: false }
}

/** Every extension a load opens by (object and scene readers); console Tab lists these first. */
export function openableExtensions(ctx: WorkerContext): string[] {
  return [OBJREADER_CATEGORY, SCENE_READER_CATEGORY].flatMap((catId) => getOpenFilters(ctx, { catId })[0]?.extensions ?? [])
}

/** The arguments every load op takes. */
export interface LoadArgs {
  rendererType: string | null
  selection: string | null
  name: string | null
  rendererName: string | null
  preset: string | null
  centerView: boolean | null
  mapCenterPolicy: MapCenterPolicy | null
}

/** What a load does when given no renderer type (`buildHeadlessFileOpenOptions`), for the rendererType docs. */
export const NULL_RENDERER_DOC =
  'Null draws a molecule with the PyMOL-like preset DefaultPymRendPreset (cartoon, ligand sticks, ion spheres, water lines) when no selection is given, and anything else with its own default renderer.'

/** The renderer arguments of `LoadArgs`, as op parameters (each load op spreads these in). */
export const LOAD_RENDERER_PARAMS = {
  rendererName: optional(string('Name of the renderer. Null uses <type>1.')),
  preset: optional(string('Draw it with this renderer preset (a group), instead of rendererType. Null leaves the choice to rendererType.')),
  centerView: optional(boolean('False leaves the view where it is. Null or true centres it on the new object.')),
  mapCenterPolicy: optional(
    enumOf(
      ['auto', 'setMapCenter', 'moveViewCenter'],
      'For a map: setMapCenter draws it around the view centre, moveViewCenter moves the view to the map. Null or auto picks by the map kind.',
    ),
  ),
}

/**
 * Write the renderer arguments a load op was given over the dialog's defaults.
 * An unnamed renderer is then named the way the GUI names it (scene-wide
 * unique, after the preset or type finally chosen), so the op and the dialog
 * give the same name. An op's load must create that renderer
 * (`requireRenderer`): a preset or type the object cannot have fails the
 * load rather than leaving a molecule nobody can see.
 */
export function applyRendererArgs(
  renderer: RendererOptions,
  args: Partial<LoadArgs>,
  scene: RendNameScope | null,
): void {
  renderer.requireRenderer = true
  if (args.preset != null) renderer.presetName = args.preset
  if (args.centerView != null) renderer.centerView = args.centerView
  if (args.mapCenterPolicy != null) renderer.mapCenterPolicy = args.mapCenterPolicy
  if (args.rendererName != null) renderer.rendererName = args.rendererName
  else if (scene) renderer.rendererName = defaultRendererName(scene, renderer)
}

/**
 * Load an object file into the scene.
 *
 * @param adjust - changes the reader's default format options (a format's
 *   own load op), or says why it cannot
 */
export function loadObjectFile(
  ctx: WorkerContext,
  oc: OpContext,
  target: Extract<OpenTarget, { scene: false }>,
  args: LoadArgs,
  adjust?: (format: FormatOptions) => FormatOptions | { error: string },
): OpOutcome {
  // A TrajBlock reader (picked by extension, by content or by name) reads into a trajectory only.
  if (getCompatibleRendererNames(ctx, { filePath: target.filePath, readerName: target.readerName }).objType === 'TrajBlock') {
    return { ok: false, error: trajectoryFramesError(target.filePath) }
  }
  const options = buildHeadlessFileOpenOptions(ctx, {
    readerName: target.readerName,
    objectName: args.name?.trim() || fileStem(target.filePath) || 'object',
    rendererType: args.rendererType,
    selection: args.selection,
    filePath: target.filePath,
  })
  applyRendererArgs(options.renderer, args, getSceneOrNull(ctx, oc.sceneId) as unknown as RendNameScope | null)
  if (adjust) {
    const format = adjust(options.format)
    if ('error' in format) return { ok: false, error: format.error }
    options.format = format
  }
  const result = loadObject(ctx, {
    filePath: target.filePath,
    sceneId: oc.sceneId,
    options,
    contentFirst: target.contentFirst,
    readerName: target.readerName,
  })
  const outcome = normalizeServiceResult(result, `"${target.filePath}" could not be opened.`)
  // A topology read without coordinates (a .psf or .prmtop alone): every atom is at the origin.
  if (outcome.ok && result.ok && result.noCoords) {
    return {
      ...outcome,
      data: {
        ...(outcome.data as Record<string, unknown>),
        note: 'No coordinates: every atom is at the origin. Add them with add_traj_block <object>, <files>.',
      },
    }
  }
  return outcome
}
