/**
 * @file worker/server/actions/actionLog.ts
 * @description The record of what each undo transaction of a scene did, as
 * native ops.
 *
 * One row per transaction on the scene's undo stack, in stack order: a commit
 * adds a row (and drops the redo side, as C++ does), undo and redo only move
 * which rows count as undone. A row holds the ops that ran inside the
 * transaction -- the op catalogue's own name and typed arguments -- so a
 * range of rows can be written out as a qax file and run again.
 *
 * Every transaction a TS caller opens goes through three helpers
 * (`withUndoTxn`, `undoTxnResult`, `runInTxn`), which call `txnBegin` /
 * `txnEnd` here. The C++ `SCE_SCENE_UNDOINFO` event is not used: it fires for
 * a nested commit and an empty one too, so it does not count transactions.
 * Anything that changes the stack without a commit (undo, redo, clearing it,
 * loading a scene) is caught by `reconcile`, which compares the rows with the
 * descriptions C++ holds and rebuilds what no longer matches.
 *
 * What fills a row:
 *
 * - an op run through `invokeOp` (console, MCP, agent, a replayed qax file);
 * - a GUI service that knows its op (`recordOp` from the service, see
 *   `serviceOps.ts`). The PyMOL dialect calls the same services, so what it
 *   did is recorded as the native ops it amounted to, never as PyMOL text;
 * - nothing, for a service with no op: the row then carries only its label.
 *
 * Runs are merged once the undo stack is long: while it holds more than
 * MAX_UNDO_STEPS steps, each run of adjacent GUI rows that did the same thing
 * to the same target (same label, same op keys) is merged, oldest run first:
 * its undo steps into one in C++ (`Scene.mergeUndoSteps`) and its rows into
 * one here, so an undo takes it back at once. Only adjacent rows are merged: every remaining step boundary
 * is still a state the scene was in. See docs/architecture/action-log.md.
 *
 * Session only: nothing here is saved with the scene.
 */

import type { Scene } from '@cuemol/core/src/wrappers/Scene'

/**
 * Who asked for a transaction: the GUI, MCP, the agent, a replayed qax file,
 * or a console dialect. A console dialect names its own source (its
 * `actionSource` in the console plugin's dialect list: `cmd`, `pym`, ...),
 * which core does not list, so any string is accepted.
 */
export type ActionSource = 'gui' | 'mcp' | 'ai' | 'qax' | 'cmd' | 'pym' | (string & {})

/** One op that ran, with what it was given. */
export interface OpEntry {
  kind: 'op'
  /** The op's catalogue name. */
  op: string
  /** The typed arguments `run` received (node refs as uids). */
  args: Record<string, unknown>
  /**
   * The path (`obj` or `obj/rend`) of each node argument as it was named
   * before the op ran, so a deleted or renamed node is written out by the
   * name it had.
   */
  refs: Record<string, string>
}

/** Something that happened which no op expresses; kept, not run again. */
export interface NoteEntry {
  kind: 'note'
  text: string
  /** Set when an op ran but was not kept, its arguments being too large. */
  dropped?: { op: string; bytes: number }
}

export type ActionEntry = OpEntry | NoteEntry

/** One undo transaction. */
export interface ActionRow {
  /**
   * Unique in the session and never reused, so a row can be named while
   * rows before or after it come and go (a commit drops the redo side). A
   * row rebuilt by `reconcile` gets a new one.
   */
  id: number
  /** The undo stack's description of it. */
  label: string
  /** Unknown when the row was rebuilt from the stack alone. */
  source: ActionSource | null
  /** ISO 8601, when it was committed; null when rebuilt. */
  time: string | null
  entries: ActionEntry[]
  /** Undone (the redo side of the stack). */
  undone: boolean
  /** How many commits this row stands for: more than 1 once a run was merged into it. */
  mergedCount?: number
  /** The ids of the rows merged into this one (it keeps the newest one's id). */
  mergedIds?: number[]
  /** A merged row's run signature, so rows that age into the run later join it. */
  runKey?: string
}

/** A transaction open on a scene. */
interface Frame {
  label: string
  source: ActionSource
  entries: ActionEntry[]
  /** The undo stack size when the outermost frame opened. */
  undoSizeBefore: number
}

interface SceneLog {
  rows: ActionRow[]
  frames: Frame[]
  /** Ops running now; a service they call must not record itself again. */
  opDepth: number
}

/** Whether old runs of the same edit are merged (off: every commit stays its own step, as before). */
let COALESCE_STEPS = true

/** Runs are merged only while the undo stack holds more steps than this. */
let MAX_UNDO_STEPS = 20

/** Change the merging settings. Tests only. */
export function setCoalescing(on: boolean, maxSteps = 20): void {
  COALESCE_STEPS = on
  MAX_UNDO_STEPS = maxSteps
}

/**
 * What an op says about merging (`Op.coalesce` / `Op.coalesceKey`), looked up
 * by name. Set by the op catalogue, which this module cannot import (the
 * catalogue's ops import the services that record into it).
 */
export interface OpCoalesceInfo {
  /** Its last call alone gives the state (it sets values, not toggles). */
  last: boolean
  /** Arguments besides its node arguments that say what it writes. */
  key: readonly string[]
}

let coalesceInfoOf: (op: string) => OpCoalesceInfo | undefined = () => undefined

/** Say where op merging information comes from (the catalogue does at load). */
export function setOpCoalesceLookup(fn: (op: string) => OpCoalesceInfo | undefined): void {
  coalesceInfoOf = fn
}

const logs = new Map<number, SceneLog>()

/** The last row id handed out. */
let lastRowId = 0

/** Listeners told when a scene's rows change. */
const listeners = new Set<(sceneId: number) => void>()

function logOf(sceneId: number): SceneLog {
  let log = logs.get(sceneId)
  if (!log) {
    log = { rows: [], frames: [], opDepth: 0 }
    logs.set(sceneId, log)
  }
  return log
}

function notify(sceneId: number): void {
  for (const fn of listeners) {
    try {
      fn(sceneId)
    } catch (e) {
      console.warn('[worker] action log listener threw:', e)
    }
  }
}

/** The undo stack as C++ holds it: descriptions oldest first, then the redo side. */
function stackOf(scene: Scene): { descs: string[]; undoSize: number } | null {
  const s = scene as unknown as Partial<Record<'getUndoSize' | 'getRedoSize' | 'getUndoDesc' | 'getRedoDesc', (i?: number) => unknown>>
  if (typeof s.getUndoSize !== 'function' || typeof s.getUndoDesc !== 'function') return null
  try {
    const nu = Number(s.getUndoSize())
    const nr = typeof s.getRedoSize === 'function' ? Number(s.getRedoSize()) : 0
    const descs: string[] = []
    for (let i = nu - 1; i >= 0; i--) descs.push(String(s.getUndoDesc(i)))
    for (let i = 0; i < nr; i++) descs.push(String(s.getRedoDesc?.(i) ?? ''))
    return { descs, undoSize: nu }
  } catch {
    return null
  }
}

function undoSizeOf(scene: Scene): number {
  try {
    const n = (scene as unknown as { getUndoSize?: () => number }).getUndoSize?.()
    return typeof n === 'number' ? n : 0
  } catch {
    return 0
  }
}

function sceneIdOf(scene: Scene): number {
  return (scene as unknown as { uid: number }).uid
}

/**
 * Bring the rows in line with the stack C++ holds: rows whose label no longer
 * matches the stack at their position are replaced by bare rows for what the
 * stack has there, and the undone flags follow the stack's undo size.
 *
 * @returns whether anything changed.
 */
function reconcile(scene: Scene, log: SceneLog): boolean {
  const stack = stackOf(scene)
  if (!stack) return false
  let changed = false
  let keep = 0
  while (keep < log.rows.length && keep < stack.descs.length && log.rows[keep].label === stack.descs[keep]) keep++
  if (keep < log.rows.length || keep < stack.descs.length) {
    log.rows = [
      ...log.rows.slice(0, keep),
      ...stack.descs.slice(keep).map((label) => ({ id: ++lastRowId, label, source: null, time: null, entries: [], undone: false })),
    ]
    changed = true
  }
  log.rows.forEach((row, i) => {
    const undone = i >= stack.undoSize
    if (row.undone !== undone) {
      row.undone = undone
      changed = true
    }
  })
  return changed
}

/**
 * A transaction opened on `scene`. Called by the transaction helpers right
 * after `startUndoTxn`.
 */
export function txnBegin(scene: Scene, label: string, source: ActionSource): void {
  const log = logOf(sceneIdOf(scene))
  const outer = log.frames.length === 0
  // Align first (an undo since the last commit moved the stack), so the row
  // this transaction makes lands at the position C++ gives it.
  if (outer) reconcile(scene, log)
  log.frames.push({ label, source, entries: [], undoSizeBefore: outer ? undoSizeOf(scene) : 0 })
}

/**
 * The transaction last opened on `scene` ended. Called by the transaction
 * helpers right after `commitUndoTxn` / `rollbackUndoTxn`.
 *
 * An inner commit hands its entries to the transaction around it; C++ folds
 * the inner one into the outer the same way. The outermost commit makes the
 * row, if the stack grew -- an empty commit adds nothing but still drops the
 * redo side.
 */
export function txnEnd(scene: Scene, committed: boolean): void {
  const sceneId = sceneIdOf(scene)
  const log = logOf(sceneId)
  const frame = log.frames.pop()
  if (!frame) return
  if (!committed) return
  const parent = log.frames[log.frames.length - 1]
  if (parent) {
    parent.entries.push(...frame.entries)
    return
  }
  const undoSize = undoSizeOf(scene)
  const grew = undoSize > frame.undoSizeBefore
  log.rows = log.rows.slice(0, frame.undoSizeBefore)
  if (grew) {
    // A GUI edit that changed the scene without saying how: a service that
    // records no op (docs/architecture/action-log.md 2.3).
    if (frame.source === 'gui' && frame.entries.length === 0 && typeof __DEV_UI__ !== 'undefined' && __DEV_UI__) {
      console.warn(`[actionLog] no op recorded: ${frame.label}`)
    }
    log.rows.push({
      id: ++lastRowId,
      label: frame.label,
      source: frame.source,
      time: new Date().toISOString(),
      entries: frame.entries,
      undone: false,
    })
  }
  reconcile(scene, log)
  if (COALESCE_STEPS) mergeOldRuns(scene, log)
  notify(sceneId)
}

/**
 * What an op entry writes: its name, its node arguments (by uid) and the
 * arguments its op names as its key (a property name, a path). Values are
 * not part of it.
 */
function entryKey(e: OpEntry): string {
  const names = [...Object.keys(e.refs), ...(coalesceInfoOf(e.op)?.key ?? [])].sort()
  return JSON.stringify([e.op, ...names.map((n) => [n, e.args[n] ?? null])])
}

/** The run a row can be part of, or null when it cannot be merged with anything. */
function runSignature(row: ActionRow): string | null {
  if (row.source !== 'gui' || row.undone) return null
  if (row.runKey !== undefined) return row.runKey
  if (row.entries.length === 0) return null
  const keys: string[] = []
  for (const e of row.entries) {
    if (e.kind !== 'op') return null
    keys.push(entryKey(e))
  }
  return JSON.stringify([row.label, keys])
}

/**
 * One row for a run of rows, oldest first. It keeps the newest row's id and
 * time. When every op of the run only sets values, the newest row's ops give
 * the whole result (the rows write the same keys), so only they are kept;
 * otherwise the ops are kept in order.
 */
function mergeRows(run: readonly ActionRow[]): ActionRow {
  const newest = run[run.length - 1]
  const allLast = run.every((r) => r.entries.every((e) => e.kind === 'op' && coalesceInfoOf(e.op)?.last === true))
  return {
    id: newest.id,
    label: run[0].label,
    source: newest.source,
    time: newest.time,
    entries: allLast ? newest.entries : run.flatMap((r) => r.entries),
    undone: false,
    mergedCount: run.reduce((n, r) => n + (r.mergedCount ?? 1), 0),
    mergedIds: run.flatMap((r) => (r === newest ? r.mergedIds ?? [] : [r.id, ...(r.mergedIds ?? [])])),
    runKey: runSignature(run[0]) ?? undefined,
  }
}

/**
 * While the undo stack holds more than MAX_UNDO_STEPS steps, merge the oldest
 * run of two or more same-signature rows; stop when it fits or no run is left.
 * The C++ position of a run counts from the newest step, so merging an older
 * run does not move the newer ones; the rows are scanned again after each
 * merge.
 */
function mergeOldRuns(scene: Scene, log: SceneLog): void {
  const s = scene as unknown as { mergeUndoSteps?: (start: number, count: number) => boolean }
  if (typeof s.mergeUndoSteps !== 'function') return
  for (;;) {
    const undoSize = log.rows.filter((r) => !r.undone).length
    if (undoSize <= MAX_UNDO_STEPS) return
    const limit = undoSize
    let start = -1
    let end = -1
    for (let i = 0; i < limit; ) {
      const sig = runSignature(log.rows[i])
      let j = i + 1
      if (sig !== null) while (j < limit && runSignature(log.rows[j]) === sig) j++
      if (sig !== null && j - i >= 2) {
        start = i
        end = j
        break
      }
      i = j
    }
    if (start < 0) return
    let merged = false
    try {
      merged = s.mergeUndoSteps(undoSize - end, end - start) === true
    } catch (e) {
      console.warn('[actionLog] mergeUndoSteps failed:', e)
    }
    if (!merged) {
      reconcile(scene, log)
      return
    }
    log.rows = [...log.rows.slice(0, start), mergeRows(log.rows.slice(start, end)), ...log.rows.slice(end)]
  }
}

/**
 * Add an op to the transaction open on the scene. Without one (an op run
 * outside any transaction, such as a scene save) there is no row to add it to,
 * and it is dropped.
 */
export function noteEntry(sceneId: number, entry: ActionEntry): void {
  const log = logs.get(sceneId)
  const frame = log?.frames[log.frames.length - 1]
  if (frame) frame.entries.push(entry)
}

/**
 * Run `body` as one op: services it calls do not record themselves, since the
 * op it is part of is what gets recorded.
 */
export async function asOneOp<T>(sceneId: number, body: () => Promise<T>): Promise<T> {
  const log = logOf(sceneId)
  log.opDepth++
  try {
    return await body()
  } finally {
    log.opDepth--
  }
}

/** Whether an op is running on the scene, so a service must not record itself. */
export function insideOp(sceneId: number): boolean {
  return (logs.get(sceneId)?.opDepth ?? 0) > 0
}

/** Whether a transaction is open on the scene. */
export function txnOpen(sceneId: number): boolean {
  return (logs.get(sceneId)?.frames.length ?? 0) > 0
}

/**
 * The rows of a scene, oldest first, brought in line with its undo stack.
 * A scene that no longer exists has none, and its record is dropped.
 */
export function actionRows(scene: Scene | null, sceneId: number): readonly ActionRow[] {
  if (!scene) {
    logs.delete(sceneId)
    return []
  }
  const log = logOf(sceneId)
  if (log.frames.length === 0 && reconcile(scene, log)) notify(sceneId)
  return log.rows
}

/**
 * Be told when a scene's rows change: a commit, or a reconcile that found the
 * stack moved (undo, redo, a clear -- whoever caused it then reads the rows,
 * see `syncActionRows`). Returns the unsubscribe.
 */
export function onActionsChanged(fn: (sceneId: number) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Bring the rows of a scene in line with its stack now and tell the
 * listeners if they moved. For a change C++ makes without a commit (undo,
 * redo, clearing the stack), which fires no event of its own.
 */
export function syncActionRows(scene: Scene | null, sceneId: number): void {
  actionRows(scene, sceneId)
}

/** Forget everything. Tests only. */
export function resetActionLog(): void {
  logs.clear()
  listeners.clear()
}
