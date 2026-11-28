/**
 * @file plugins/mdtools/worker/attachTrajectory.ts
 * @description Attaching dropped trajectory files to a molecule already in the
 * scene (PyMOL's load of a trajectory onto an object).
 *
 * Runs in the Web Worker thread; wrappers are sync. A Trajectory target gets
 * the files appended as blocks. A plain molecule is first converted into a
 * Trajectory the way `convertToMorphMol` converts into a MorphMol (XML round
 * trip with the type overwritten, then the objects swapped). Its own
 * coordinates stay as frame 0:
 *   - opened as topology + coordinate file (prmtop + rst7, PSF + coor: the
 *     topology reader's "coord" sub-stream): the topology is read back without
 *     the sub-stream and the coordinate file becomes a one-frame block, so the
 *     Trajectory holds the same blocks as one assembled from the files;
 *   - a molecule without coordinates (a topology-only file): no frame-0 block,
 *     it starts at the first dropped file, and every view is fitted to it
 *     after the attach (it has just become visible);
 *   - any other molecule: a `structframe` block referencing its structure file.
 * Everything is one undo txn, so a failure (most often an atom count that does
 * not match) leaves the molecule as it was.
 *
 * Molecules that cannot be converted are refused, both in the target list
 * (with the reason) and here, for callers other than the dialog:
 *   - MorphMol: its morph frames would not carry over to the Trajectory.
 *   - a non-identity transformation matrix: Trajectory drops it, so the
 *     molecule would jump.
 *   - an edited molecule, or one without a local source file: it would be
 *     embedded in a .qsc (the same rule as SceneXMLWriter), and the frame-0
 *     block needs the original file to reference.
 */

import * as fs from 'fs';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { undoTxnResult } from '@renderer/worker/server/services/withUndoTxn';
import { safeRead } from '@renderer/worker/server/services/helpers/safeRead';
import { isMoleculeClass } from '@renderer/worker/shared/objectClasses';
import { listSceneObjects } from '@renderer/worker/server/services/scene/listSceneObjects';
import { fail, ok, type Result } from '@renderer/worker/shared/result';
import { hasNoCoords } from '@renderer/worker/server/services/helpers/hasNoCoords';
import { focusAllViewsOnNode } from '@renderer/worker/server/services/sceneTree/sceneOps';
import {
    appendCoordFile,
    appendStructFrame,
    appendTrajFile,
    applyLoadSel,
    fileAtomCount,
    unsupportedTrajFormat,
    type TrajAppendTarget,
} from './trajBlocks';
import { COORD_BLOCK_READER_BY_TOPOLOGY } from '../trajFormats';
import { recordAddTrajBlock } from './recordTraj';
import { baseName, reportTask } from '@renderer/worker/server/services/helpers/taskReport';

const log = console;

/** Minimal surface of a molecule (driven through casts). */
interface MolHandle {
    uid: number;
    name: string;
    ui_order: number;
    modified: boolean;
    src: string;
    alt_src: string;
    srctype: string;
    xformMat: { isIdent(): boolean };
    getClassName(): string;
    getAtomSize(): number;
    /** Trajectory only: the topology's full atom count. */
    getAllAtomSize?(): number;
    /** Absolute path of the reader sub-stream `key`, '' when none. */
    getSubSrcPath(key: string): string;
}

interface SceneHandle {
    uid: number;
    view_uids: string;
    getObject(uid: number): unknown;
    destroyObject(uid: number): boolean;
    addObject(obj: unknown): void;
}

/** One molecule the dialog offers as a target. */
export interface AttachTarget {
    uid: number;
    name: string;
    /** C++ class name; `Trajectory` gets blocks appended, others are converted. */
    className: string;
    natoms: number;
    /** Read without coordinates (a topology-only file); starts at the first dropped file. */
    noCoords?: boolean;
    /** Why it cannot be chosen; absent when it can. */
    reason?: string;
}

export interface ListAttachTargetsArgs {
    sceneId: number;
    /** The dropped trajectory files; only molecules with their atom count are listed. */
    paths: string[];
}

export interface ListAttachTargetsResult {
    targets: AttachTarget[];
    /**
     * The atom count the files declare, when every file's header could be
     * read and they agree; the list was filtered by it. Absent when the count
     * could not be told (nothing filtered) or the files disagree (-1).
     */
    fileAtoms?: number;
    /** Molecules of the scene the atom count left out. */
    mismatched: number;
}

export interface AttachTrajectoryArgs {
    sceneId: number;
    /** The molecule (or Trajectory) to attach to. */
    objId: number;
    /** Trajectory files, in frame order. */
    trajPaths: string[];
    /** Keep every Nth frame (applied to every file). Default 1. */
    nevery?: number;
    /** The block reader for every file; by default each file's extension picks one. */
    reader?: string | null;
    /**
     * Keep only the atoms this selection picks. Only for a molecule being
     * converted (applied before frame 0): a Trajectory has dropped atoms for good.
     */
    loadSel?: string | null;
    /**
     * Replace the frames instead of adding after them: a converted molecule
     * gets no frame 0 of its own coordinates, and a Trajectory loses its blocks.
     */
    replace?: boolean;
}

/**
 * `objId` of the Trajectory the files ended up in (new when converted) and
 * its frame count after the attach.
 */
export type AttachTrajectoryResult = Result<{ objId: number; nframe: number }>;

/** The local structure file a molecule was read from, or '' when there is none. */
function localSourceOf(mol: MolHandle): string {
    const src = safeRead(() => mol.src) ?? '';
    const alt = safeRead(() => mol.alt_src) ?? '';
    for (const p of [src, alt]) {
        if (!p || p.startsWith('datachunk:') || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) continue;
        if (fs.existsSync(p)) return p;
    }
    return '';
}

/**
 * The coordinate file `mol` was opened with (its topology reader's "coord"
 * sub-stream) and the block reader that reads it, or undefined when it has
 * none (or its topology reader has no block reader for it).
 */
function coordFileOf(mol: MolHandle): { path: string; reader: string } | undefined {
    const reader = COORD_BLOCK_READER_BY_TOPOLOGY[safeRead(() => mol.srctype) ?? ''];
    if (!reader) return undefined;
    const path = safeRead(() => mol.getSubSrcPath('coord')) ?? '';
    return path ? { path, reader } : undefined;
}

/**
 * Why `mol` (a plain molecule, not a Trajectory) cannot be converted, or ''
 * when it can.
 */
function conversionRefusal(mol: MolHandle): string {
    if (!(safeRead(() => mol.xformMat.isIdent()) ?? true)) {
        return 'has a transformation matrix (moved by superpose or similar)';
    }
    if (safeRead(() => mol.modified) ?? false) return 'has been edited';
    if (!(safeRead(() => mol.srctype) ?? '') || !localSourceOf(mol)) {
        return 'has no original file to read its coordinates from';
    }
    const coord = coordFileOf(mol);
    if (coord && !fs.existsSync(coord.path)) return `has lost its coordinate file (${coord.path})`;
    return '';
}

/**
 * The one atom count all `paths` declare: undefined when some header cannot
 * be read (no filtering then; the attach itself still checks), -1 when they
 * disagree (no molecule can take them all).
 */
function commonFileAtoms(ctx: WorkerContext, paths: string[]): number | undefined {
    let common: number | undefined;
    for (const p of paths) {
        const n = fileAtomCount(ctx, p);
        if (n <= 0) return undefined;
        if (common === undefined) common = n;
        else if (common !== n) return -1;
    }
    return common;
}

/** Every atom of a molecule, as a trajectory file has to match it. */
function topologyAtoms(mol: MolHandle, className: string): number {
    if (className === 'Trajectory') {
        const n = safeRead(() => mol.getAllAtomSize?.());
        if (n !== undefined && n > 0) return n;
    }
    return safeRead(() => mol.getAtomSize()) ?? 0;
}

/**
 * The molecules of a scene the attach dialog lists: those whose atom count
 * matches the dropped files, each with the reason when it cannot take them.
 */
export function listAttachTargets(
    ctx: WorkerContext,
    args: ListAttachTargetsArgs,
): ListAttachTargetsResult {
    const scene = ctx.sceMgr.getScene(args.sceneId) as unknown as SceneHandle | null;
    if (!scene) return { targets: [], mismatched: 0 };
    const fileAtoms = commonFileAtoms(ctx, args.paths);
    let mismatched = 0;
    const targets: AttachTarget[] = [];
    for (const { uid, className } of listSceneObjects(ctx, { sceneId: args.sceneId }).objects) {
        // MorphMol is left out: its morph frames would be lost.
        if (!isMoleculeClass(className) || className === 'MorphMol') continue;
        const mol = scene.getObject(uid) as MolHandle | null;
        if (!mol) continue;
        const natoms = topologyAtoms(mol, className);
        if (fileAtoms !== undefined && natoms !== fileAtoms) {
            mismatched++;
            continue;
        }
        const reason = className === 'Trajectory' ? '' : conversionRefusal(mol);
        targets.push({
            uid,
            name: safeRead(() => mol.name) ?? '',
            className,
            natoms,
            ...(hasNoCoords(mol) ? { noCoords: true } : {}),
            ...(reason ? { reason } : {}),
        });
    }
    return { targets, mismatched, ...(fileAtoms !== undefined ? { fileAtoms } : {}) };
}

/**
 * Convert `mol` into a Trajectory in place (same name and scene-tree
 * position) and append its own coordinates as frame 0 (see the file header).
 * Runs inside the caller's txn.
 *
 * @param loadSel - applied to the new Trajectory before frame 0 is appended
 * @param frame0 - whether to append the molecule's own coordinates as frame 0
 */
function convertToTrajectory(
    ctx: WorkerContext,
    scene: SceneHandle,
    mol: MolHandle,
    noCoords: boolean,
    loadSel: string | null,
    frame0: boolean,
): TrajAppendTarget {
    const name = mol.name;
    const uiOrder = mol.ui_order;
    const srcPath = localSourceOf(mol);
    const srcType = mol.srctype;
    const coord = coordFileOf(mol);
    type MolArg = Parameters<typeof ctx.strMgr.toXML2>[0];
    // With a coordinate file, the topology is read back from its main file
    // alone: the coordinates move to their own block.
    const xml = coord
        ? ctx.strMgr.toXML2NoSubSrc(mol as unknown as MolArg, 'Trajectory')
        : ctx.strMgr.toXML2(mol as unknown as MolArg, 'Trajectory');
    const traj = ctx.strMgr.fromXML(xml, scene.uid) as unknown as (TrajAppendTarget & MolHandle) | null;
    if (!traj) throw new Error('conversion to a trajectory failed');
    traj.name = name;
    scene.destroyObject(mol.uid);
    scene.addObject(traj);
    // ui_order is not persisted, so the round trip gave the new object one of
    // its own (the end of the scene tree); put it back where the molecule was.
    traj.ui_order = uiOrder;
    if (loadSel) applyLoadSel(ctx, scene.uid, traj, loadSel);
    if (!frame0) return traj;
    if (coord) appendCoordFile(ctx, traj, coord.path, coord.reader);
    else if (!noCoords) appendStructFrame(ctx, traj, srcPath, srcType);
    return traj;
}

/** Remove every block of a Trajectory (its frames), last first. Runs inside the caller's txn. */
function removeAllBlocks(traj: TrajAppendTarget): void {
    const t = traj as unknown as { nblock: number; removeBlock(index: number): void };
    for (let i = t.nblock - 1; i >= 0; i--) t.removeBlock(i);
}

/** Attach trajectory files to a molecule or Trajectory of the scene (one undo step). */
export function attachTrajectory(
    ctx: WorkerContext,
    args: AttachTrajectoryArgs,
): AttachTrajectoryResult {
    if (!args.trajPaths.length) return fail('no trajectory files given', 'invalid-args');
    const unsupported = unsupportedTrajFormat(args.trajPaths, args.reader);
    if (unsupported) return fail(unsupported, 'unsupported');
    const scene = ctx.sceMgr.getScene(args.sceneId) as unknown as SceneHandle | null;
    if (!scene) return fail(`scene ${args.sceneId} not found`, 'not-found');
    const mol = scene.getObject(args.objId) as MolHandle | null;
    if (!mol) return fail('molecule not found', 'not-found');
    const className = safeRead(() => mol.getClassName()) ?? '';
    if (!isMoleculeClass(className)) return fail('not a molecule', 'invalid-args');
    if (className === 'MorphMol') {
        return fail('a morph animation cannot take a trajectory', 'unsupported');
    }
    const isTraj = className === 'Trajectory';
    if (isTraj && args.loadSel) {
        return fail(
            `"${mol.name}" is already a trajectory: a load selection can only be given when a molecule becomes one`,
            'invalid-args',
        );
    }
    if (!isTraj) {
        const reason = conversionRefusal(mol);
        if (reason) return fail(`"${mol.name}" ${reason}, so a trajectory cannot be attached`, 'unsupported');
    }
    const nevery = args.nevery && args.nevery > 1 ? args.nevery : 1;
    const noCoords = hasNoCoords(mol);

    log.info(`[worker] attaching ${args.trajPaths.length} trajectory file(s) to ${mol.name}`);
    // A throw (atom-count mismatch, missing reader) rolls the conversion and
    // every block back and comes out as a Fail.
    const res = undoTxnResult(scene as unknown as Parameters<typeof undoTxnResult>[0], 'Attach MD trajectory', () => {
        // While objId still names the molecule (a conversion replaces it).
        recordAddTrajBlock(ctx, scene.uid, {
            objId: args.objId,
            paths: args.trajPaths,
            reader: args.reader ?? null,
            nevery,
            loadSel: args.loadSel ?? null,
            replace: args.replace ?? false,
        });
        const traj = isTraj
            ? (mol as unknown as TrajAppendTarget)
            : convertToTrajectory(ctx, scene, mol, noCoords, args.loadSel ?? null, !args.replace);
        if (isTraj && args.replace) removeAllBlocks(traj);
        // One step per file, reported before its synchronous read (long-task
        // indicator).
        const total = args.trajPaths.length;
        args.trajPaths.forEach((p, i) => {
            reportTask(ctx, { label: 'Attaching MD trajectory', detail: baseName(p), step: i + 1, total });
            appendTrajFile(ctx, traj, p, nevery, args.reader);
        });
        const nframe = safeRead(() => (traj as unknown as { nframe: number }).nframe) ?? 0;
        return ok({ objId: traj.uid, nframe });
    });
    // It had nothing to show until now (all atoms at the origin): bring it
    // into every view. Not part of the undo step, like any view change.
    if (res.ok && noCoords) focusAllViewsOnNode(ctx, scene, res.objId, 'object');
    return res;
}
