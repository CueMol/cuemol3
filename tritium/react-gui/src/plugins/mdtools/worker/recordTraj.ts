/**
 * @file plugins/mdtools/worker/recordTraj.ts
 * @description What an MD trajectory service did, said as the op that does
 * the same (`./trajOps.ts`), for the action log.
 *
 * The GUI (the Open MD Trajectory dialog, a drop, the Trajectory panel) calls
 * the services directly; each records its op from inside its own undo
 * transaction, so the History row can be saved to Actions and run again. A
 * console or MCP call runs the op itself, which is what gets recorded then
 * (`recordOp` records nothing while an op runs).
 *
 * The argument names here are the ops' parameter names.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes';
import { recordedRendererName, recordOp } from '@renderer/worker/server/actions/serviceOps';

/** The op names, shared with `./trajOps.ts`. */
export const TRAJ_OP = {
    load: 'load_trajectory',
    add: 'add_traj_block',
    remove: 'remove_traj_block',
    move: 'move_traj_block',
    list: 'list_traj_blocks',
} as const;

/** A `load_trajectory` call. Call before the renderer is created (its default name). */
export function recordLoadTrajectory(
    ctx: WorkerContext,
    sceneId: number,
    a: {
        topology: string;
        paths: string[];
        reader: string | null;
        nevery: number;
        loadSel: string | null;
        renderer: RendererOptions;
    },
): void {
    const r = a.renderer;
    recordOp(ctx, sceneId, TRAJ_OP.load, {
        topology: a.topology,
        paths: a.paths,
        reader: a.reader,
        nevery: a.nevery > 1 ? a.nevery : null,
        loadSel: a.loadSel,
        rendererType: r.presetName ? null : r.rendererType || null,
        selection: r.selectionEnabled ? r.selection : null,
        name: r.objectName || null,
        rendererName: recordedRendererName(ctx, sceneId, r),
        preset: r.presetName ? r.presetName : null,
        centerView: r.centerView ? null : false,
    });
}

/** An `add_traj_block` call. Call while `objId` still names the molecule (before a conversion). */
export function recordAddTrajBlock(
    ctx: WorkerContext,
    sceneId: number,
    a: { objId: number; paths: string[]; reader: string | null; nevery: number; loadSel: string | null; replace: boolean },
): void {
    recordOp(
        ctx,
        sceneId,
        TRAJ_OP.add,
        {
            objId: a.objId,
            paths: a.paths,
            reader: a.reader,
            nevery: a.nevery > 1 ? a.nevery : null,
            loadSel: a.loadSel,
            replace: a.replace ? true : null,
        },
        ['objId'],
    );
}

/** A `remove_traj_block` call. */
export function recordRemoveTrajBlock(ctx: WorkerContext, sceneId: number, objId: number, index: number): void {
    recordOp(ctx, sceneId, TRAJ_OP.remove, { objId, index }, ['objId']);
}

/** A `move_traj_block` call: the block moved from `from` to `to`, recorded as `by` places. */
export function recordMoveTrajBlock(ctx: WorkerContext, sceneId: number, objId: number, from: number, to: number): void {
    recordOp(ctx, sceneId, TRAJ_OP.move, { objId, index: from, by: to - from }, ['objId']);
}
