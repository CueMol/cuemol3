/**
 * @file plugins/mdtools/worker/trajBlocks.ts
 * @description Reading trajectory files into blocks of a Trajectory: the part
 * the open, add-block and attach services share.
 *
 * Runs in the Web Worker thread; wrappers are sync. A block reader resolves
 * its parent Trajectory through `targTrajUID`, so the Trajectory must already
 * be registered (in a scene) when these run. Errors (a missing reader, an
 * atom count that does not match the topology) are thrown, for the caller's
 * undo txn to roll back.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { OBJREADER_CATEGORY } from '@renderer/worker/server/services/helpers/pickReaderName';
import { makeSel } from '@renderer/worker/server/services/helpers/makeSel';
import { SINGLE_FRAME_READERS, TRAJ_READER_BY_EXT, fileExt } from '../trajFormats';

export { TRAJ_READER_BY_EXT, fileExt };

/** The block reader that reads a structure file as one frame (frame 0 of a converted molecule). */
const STRUCT_FRAME_READER = 'structframe';

/** Minimal surface of a block reader (driven through casts). */
interface TrajBlockReaderHandle {
    targTrajUID: number;
    nevery: number;
    struct_type: string;
    setPath(path: string): void;
    attach(obj: unknown): void;
    read(): void;
    detach(): void;
    createDefaultObj(): unknown;
    getFileAtomCount(): number;
}

/** Minimal surface of the Trajectory blocks are appended to. */
export interface TrajAppendTarget {
    uid: number;
    append(block: unknown): void;
}

/**
 * The refusal for the first of `paths` no block reader reads (by extension),
 * or undefined when every one has a reader. Checked before a txn starts, so an
 * unsupported file is reported as such rather than as a failed read.
 */
export function unsupportedTrajFormat(paths: readonly string[], reader?: string | null): string | undefined {
    // A reader named by the caller reads every file, whatever its extension.
    if (reader) return undefined;
    for (const p of paths) {
        const ext = fileExt(p);
        if (!TRAJ_READER_BY_EXT[ext]) return `unsupported trajectory format ".${ext}": ${p}`;
    }
    return undefined;
}

/** Create the block reader `nick` aimed at `traj`, or throw. */
function blockReader(ctx: WorkerContext, nick: string, traj: TrajAppendTarget): TrajBlockReaderHandle {
    const reader = ctx.strMgr.createHandler(nick, OBJREADER_CATEGORY) as unknown as
        | TrajBlockReaderHandle
        | null;
    if (!reader) throw new Error(`trajectory reader "${nick}" not available`);
    reader.targTrajUID = traj.uid;
    return reader;
}

/** Read `path` with `reader` into a new block and append it to `traj`. */
function readAndAppend(reader: TrajBlockReaderHandle, traj: TrajAppendTarget, path: string): void {
    const block = reader.createDefaultObj();
    reader.attach(block);
    reader.setPath(path);
    reader.read();
    reader.detach();
    traj.append(block);
}

/**
 * The atom count a trajectory file declares in its header, or -1 when it
 * cannot be told (unknown extension, unreadable header). Reads no frames.
 */
export function fileAtomCount(ctx: WorkerContext, path: string): number {
    const nick = TRAJ_READER_BY_EXT[fileExt(path)];
    if (!nick) return -1;
    try {
        const reader = ctx.strMgr.createHandler(nick, OBJREADER_CATEGORY) as unknown as
            | TrajBlockReaderHandle
            | null;
        if (!reader) return -1;
        reader.setPath(path);
        return reader.getFileAtomCount();
    } catch {
        return -1;
    }
}

/**
 * Read one trajectory file and append it to `traj`.
 *
 * @param nevery - keep every Nth frame (1 = all)
 * @param reader - the block reader to read it with; by default the one its
 *   extension names
 * @throws on an unsupported extension, a missing reader or an atom-count mismatch
 */
export function appendTrajFile(
    ctx: WorkerContext,
    traj: TrajAppendTarget,
    path: string,
    nevery: number,
    reader?: string | null,
): void {
    const ext = fileExt(path);
    const nick = reader || TRAJ_READER_BY_EXT[ext];
    if (!nick) throw new Error(`unsupported trajectory format ".${ext}": ${path}`);
    const blockRd = blockReader(ctx, nick, traj);
    // A one-frame reader has no frame sampling (and no nevery property).
    if (nevery > 1 && !SINGLE_FRAME_READERS.has(nick)) blockRd.nevery = nevery;
    readAndAppend(blockRd, traj, path);
}

/** Minimal surface of a Trajectory a load selection is applied to. */
interface LoadSelTarget {
    applyLoadSel(sel: unknown): void;
}

/**
 * Keep only the atoms `selStr` selects (`Trajectory::applyLoadSel`): the
 * others are removed from the molecule for good, and every block reads only
 * the kept atoms. Only before the first block is appended.
 *
 * @throws on a selection that does not parse, or once a block is there
 */
export function applyLoadSel(ctx: WorkerContext, sceneId: number, traj: unknown, selStr: string): void {
    const sel = makeSel(ctx, selStr, sceneId);
    if (!sel) throw new Error(`invalid selection: ${selStr}`);
    (traj as LoadSelTarget).applyLoadSel(sel);
}

/**
 * Append the coordinate file a molecule was opened with (its topology
 * reader's "coord" sub-stream) as a one-frame block read by `nick`.
 */
export function appendCoordFile(
    ctx: WorkerContext,
    traj: TrajAppendTarget,
    path: string,
    nick: string,
): void {
    readAndAppend(blockReader(ctx, nick, traj), traj, path);
}

/**
 * Append the structure file the topology was read from as a one-frame block,
 * so the molecule's own coordinates stay as a frame (a `structframe` block,
 * stored in a .qsc as a reference to that file).
 *
 * @param srcPath - the structure file (the topology's source)
 * @param srcType - the molecule reader nickname the topology was read with
 */
export function appendStructFrame(
    ctx: WorkerContext,
    traj: TrajAppendTarget,
    srcPath: string,
    srcType: string,
): void {
    const reader = blockReader(ctx, STRUCT_FRAME_READER, traj);
    reader.struct_type = srcType;
    readAndAppend(reader, traj, srcPath);
}
