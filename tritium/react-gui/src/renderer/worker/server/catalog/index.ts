/**
 * @file worker/server/catalog/index.ts
 * @description The op catalogue: every operation offered to the callers that
 * drive CueMol by name (the AI agent, the console, an MCP server).
 *
 * Sorted by name and frozen in that order. The agent's tool list is part of
 * its cached prompt prefix, so a catalogue that reordered itself between
 * turns would miss the cache every time for no benefit.
 *
 * Files here are deliberately NOT named `*.service.ts`: the worker registry
 * globs that pattern and would try to register an op module as a service.
 */

import type { AnyOp } from './op'
import { setOpCoalesceLookup } from '../actions/actionLog'
import { ANALYSIS_OPS } from './ops/analysisOps'
import { ANIM_OPS } from './ops/animOps'
import { APBS_OPS } from './ops/apbsOps'
import { EDIT_OPS } from './ops/editOps'
import { LOAD_FORMAT_OPS } from './ops/loadFormatOps'
import { TOOL_MENU_OPS } from './ops/toolOps'
import { FILE_OPS } from './ops/fileOps'
import { MEASURE_OPS } from './ops/measureOps'
import { PROP_OPS } from './ops/propOps'
import { RENDERER_OPS } from './ops/rendererOps'
import { SCENE_OPS } from './ops/sceneOps'
import { SELECTION_OPS } from './ops/selectionOps'
import { VIEW_OPS } from './ops/viewOps'
import { CAMERA_OPS } from './ops/cameraOps'
import { MAP_OPS } from './ops/mapOps'
import { MOL_OPS } from './ops/molOps'
import { MORE_OPS } from './ops/moreOps'
import { RENDER_OPS } from './ops/renderOps'
import { STYLE_OPS } from './ops/styleOps'
import type { ToolsetId } from './toolsets'

export type { AnyOp, Op, OpContext, OpImage, OpOutcome, OpAlias, OpTable } from './op'
export { defineOp, toolDescription } from './op'
export { invokeOp, runExclusive, runInTxn, TXN_BUSY_MESSAGE, txnBusy, txnLabel } from './opRuntime'
export { MAX_ARRAY_ITEMS, MAX_OUTPUT_CHARS, serializeToolOutput } from './toolOutput'
export { paramsSchema, readToolArgs, toolSchema } from './toolSchema'
export type { StrictObjectSchema } from './toolSchema'
export { TOOLSETS } from './toolsets'
export type { Toolset, ToolsetId } from './toolsets'

function byName(a: AnyOp, b: AnyOp): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The core ops, before any plugin adds its own. */
const CORE_OPS: readonly AnyOp[] = [
  ...SCENE_OPS,
  ...SELECTION_OPS,
  ...RENDERER_OPS,
  ...PROP_OPS,
  ...FILE_OPS,
  ...ANALYSIS_OPS,
  ...MEASURE_OPS,
  ...VIEW_OPS,
  ...CAMERA_OPS,
  ...STYLE_OPS,
  ...MAP_OPS,
  ...MOL_OPS,
  ...MORE_OPS,
  ...RENDER_OPS,
  ...APBS_OPS,
  ...TOOL_MENU_OPS,
  ...ANIM_OPS,
  ...EDIT_OPS,
  ...LOAD_FORMAT_OPS,
]

/** The lists made from the catalogue, rebuilt only when a plugin adds ops. */
interface Views {
  all: readonly AnyOp[]
  tool: readonly AnyOp[]
  mcp: readonly AnyOp[]
  console: readonly AnyOp[]
  byName: ReadonlyMap<string, AnyOp>
}

function buildViews(ops: readonly AnyOp[]): Views {
  const all = [...ops].sort(byName)
  return {
    all,
    tool: all.filter((op) => op.expose.tool === 'core'),
    mcp: all.filter(isMcpOp),
    console: all.filter((op) => op.expose.console),
    byName: new Map(all.map((op) => [op.name, op])),
  }
}

let views: Views = buildViews(CORE_OPS)

/**
 * Add a plugin's ops to the catalogue.
 *
 * Called by the plugin's worker module when the worker registers services,
 * before any caller runs, so every caller sees the same catalogue. The lists
 * below are read through functions because a module that loads before the
 * plugin's (the glob order of the worker services) would otherwise keep the
 * core ops alone.
 *
 * @param pluginId - the plugin adding them, for the error on a name clash
 * @param ops - its ops
 * @throws when an op name is already in the catalogue
 */
export function registerPluginOps(pluginId: string, ops: readonly AnyOp[]): void {
  for (const op of ops) {
    if (views.byName.has(op.name)) {
      throw new Error(`plugin ${pluginId}: op "${op.name}" is already in the catalogue`)
    }
  }
  views = buildViews([...views.all, ...ops])
}

/** Every op, sorted by name. The same array until a plugin adds ops. */
export function allOps(): readonly AnyOp[] {
  return views.all
}

/** The ops always offered to a tool caller, in catalogue order. */
export function toolOps(): readonly AnyOp[] {
  return views.tool
}

/** The ops one toolset adds once it is switched on, in catalogue order. */
export function toolsetOps(id: ToolsetId): readonly AnyOp[] {
  return views.all.filter((op) => op.expose.tool === id)
}

/**
 * The ops an MCP client is offered: every op a tool caller may use, toolsets
 * included (a client picks from all its servers' tools itself), and the
 * MCP-only ones.
 */
export function isMcpOp(op: AnyOp): boolean {
  return op.expose.tool !== false || op.expose.mcp === true
}

/** The ops `isMcpOp` offers, in catalogue order. */
export function mcpOps(): readonly AnyOp[] {
  return views.mcp
}

/** The ops a console makes commands of, in catalogue order. The same array until a plugin adds ops. */
export function consoleCommandOps(): readonly AnyOp[] {
  return views.console
}

/** Lookup by name. */
export function findOp(name: string): AnyOp | undefined {
  return views.byName.get(name)
}

// The action log merges old runs of the same edit by what each op says.
setOpCoalesceLookup((name) => {
  const op = findOp(name)
  return op ? { last: op.coalesce === 'last', key: op.coalesceKey ?? [] } : undefined
})
