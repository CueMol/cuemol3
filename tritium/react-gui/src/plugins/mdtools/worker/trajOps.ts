/**
 * @file plugins/mdtools/worker/trajOps.ts
 * @description The MD trajectory ops this plugin adds to the op catalogue:
 * opening a trajectory, adding files to a molecule or trajectory, and
 * listing, removing and reordering its blocks.
 *
 * Registered by `mdtools.service.ts` (`registerPluginOps`), so the native
 * console makes commands of them, MCP clients list them, and the AI agent
 * has them in its `md` toolset. Each runs the service the GUI runs, so a
 * console call and a dialog do the same thing; the services record these
 * ops for the GUI (`recordTraj.ts`), and an op call is recorded as itself.
 *
 * Blocks are numbered from 0, in frame order, as `list_traj_blocks` shows.
 */

import { defineOp } from '@renderer/worker/server/catalog';
import type { AnyOp, OpTable } from '@renderer/worker/server/catalog';
import { applyRendererArgs } from '@renderer/worker/server/catalog/fileLoad';
import { callerPath } from '@renderer/worker/server/catalog/outputFile';
import {
    boolean,
    enumOf,
    integer,
    objectId,
    optional,
    path,
    paths,
    rendererType,
    selection,
    string,
} from '@renderer/worker/server/catalog/params';
import { buildHeadlessFileOpenOptions } from '@renderer/worker/server/services/file/headlessOpen';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import type { RendNameScope } from '@renderer/worker/server/services/rend/defaultRendererName';
import { normalizeServiceResult } from '@renderer/worker/shared/serviceResult';
import { fileStem } from '@shared/fileExt';
import { TOPOLOGY_READER_BY_EXT, TRAJ_READER_BY_EXT, fileExt } from '../trajFormats';
import { attachTrajectory } from './attachTrajectory';
import { loadTrajectory } from './loadTrajectory';
import { TRAJ_OP } from './recordTraj';
import { getTrajectoryState, moveTrajectoryBlock, removeTrajectoryBlock } from './trajectory';

const EXPOSE = { tool: 'md', console: true } as const;

/** The block readers a caller may name instead of letting the extension pick. */
const BLOCK_READERS = [...new Set(Object.values(TRAJ_READER_BY_EXT))] as [string, ...string[]];

const TRAJ_EXTS = Object.keys(TRAJ_READER_BY_EXT).map((e) => `.${e}`).join(' ');
const TOPOLOGY_EXTS = Object.keys(TOPOLOGY_READER_BY_EXT).map((e) => `.${e}`).join(' ');

/** The arguments the two loading ops share. */
const READ_PARAMS = {
    reader: optional(
        enumOf(BLOCK_READERS, 'The reader for every file, when the extension does not say. Null picks by extension.'),
    ),
    nevery: optional(integer('Keep every Nth frame of each file. Null keeps all.')),
    loadSel: optional(
        selection(
            'Keep only these atoms (the others are dropped from the molecule for good, which saves memory ' +
                'on a solvated system). Null keeps every atom.',
        ),
    ),
};

/** `{ objId, nframe }` as a console line. */
function framesLine(data: unknown): string[] {
    const d = data as { nframe?: number };
    return typeof d?.nframe === 'number' ? [`${d.nframe} frame(s)`] : [];
}

/** The frame count of a Trajectory, for a result. */
function nframeOf(ctx: Parameters<AnyOp['run']>[0], sceneId: number, objId: number): number {
    const state = getTrajectoryState(ctx, { sceneId, objId });
    return state.ok ? state.nframe : 0;
}

export const loadTrajectoryOp = defineOp({
    name: TRAJ_OP.load,
    description:
        `Open an MD trajectory: a topology file (${TOPOLOGY_EXTS}) and its trajectory or coordinate ` +
        `files (${TRAJ_EXTS}), whose frames follow one another in the order given. ` +
        'To add files to a molecule already open, use add_traj_block.',
    params: {
        topology: path('The topology file.'),
        paths: paths('The trajectory files, in frame order.'),
        ...READ_PARAMS,
        rendererType: optional(rendererType('Renderer to create for it. Null draws it with the molecule preset.')),
        selection: optional(selection('Draw only this selection. Null draws everything.')),
        name: optional(string('Name of the new object. Null uses the topology file name.')),
        rendererName: optional(string('Name of the renderer. Null uses <type>1.')),
        preset: optional(string('Draw it with this renderer preset (a group), instead of rendererType.')),
        centerView: optional(boolean('False leaves the view where it is. Null or true centres it on the new object.')),
    },
    mutates: true,
    expose: EXPOSE,
    group: 'files',
    describe: (a) => `Open MD trajectory ${fileStem(a.topology)} (${a.paths.length} file(s))`,
    format: framesLine,
    run(ctx, args, oc) {
        const topology = callerPath(args.topology);
        const readerName = TOPOLOGY_READER_BY_EXT[fileExt(topology)];
        if (!readerName) return { ok: false, error: `${topology} is not a topology file (${TOPOLOGY_EXTS}).` };
        const options = buildHeadlessFileOpenOptions(ctx, {
            readerName,
            objectName: args.name?.trim() || fileStem(topology),
            rendererType: args.rendererType,
            selection: args.selection,
            filePath: topology,
        });
        const scene = getSceneOrNull(ctx, oc.sceneId) as unknown as RendNameScope | null;
        applyRendererArgs(options.renderer, args, scene);
        const res = loadTrajectory(ctx, {
            sceneId: oc.sceneId,
            topologyPath: topology,
            trajPaths: args.paths.map(callerPath),
            nevery: args.nevery ?? 1,
            reader: args.reader,
            loadSel: args.loadSel,
            renderer: options.renderer,
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, data: { objId: res.objId, nframe: nframeOf(ctx, oc.sceneId, res.objId) } };
    },
});

export const addTrajBlockOp = defineOp({
    name: TRAJ_OP.add,
    description:
        `Add trajectory or coordinate files (${TRAJ_EXTS}) to a molecule or MD trajectory, as blocks of ` +
        'frames after its own. A molecule becomes a trajectory, its own coordinates kept as frame 0. ' +
        'With replace, the files take the place of every frame instead.',
    params: {
        objId: objectId('Uid of the molecule or trajectory.', 'MolCoord'),
        paths: paths('The trajectory files, in frame order.'),
        ...READ_PARAMS,
        replace: optional(
            boolean(
                'True: replace the frames -- a molecule keeps no frame 0 of its own coordinates, and a ' +
                    'trajectory loses its blocks. Null adds after them.',
            ),
        ),
    },
    mutates: true,
    expose: EXPOSE,
    group: 'files',
    describe: (a, n) => `${a.replace ? 'Replace frames of' : 'Add frames to'} ${n('objId')} (${a.paths.length} file(s))`,
    format: framesLine,
    run(ctx, args, oc) {
        const res = attachTrajectory(ctx, {
            sceneId: oc.sceneId,
            objId: args.objId,
            trajPaths: args.paths.map(callerPath),
            nevery: args.nevery ?? 1,
            reader: args.reader,
            loadSel: args.loadSel,
            replace: args.replace ?? false,
        });
        return normalizeServiceResult(res, 'The trajectory files could not be added.');
    },
});

export const listTrajBlocksOp = defineOp({
    name: TRAJ_OP.list,
    description: 'List the blocks of an MD trajectory: each file, its frames and where they start, numbered from 0.',
    params: {
        objId: objectId('Uid of the trajectory.', 'Trajectory'),
    },
    mutates: false,
    expose: EXPOSE,
    group: 'animation',
    run(ctx, args, oc) {
        const state = getTrajectoryState(ctx, { sceneId: oc.sceneId, objId: args.objId });
        if (!state.ok) return { ok: false, error: 'That object is not a trajectory.' };
        return {
            ok: true,
            data: {
                nframe: state.nframe,
                blocks: state.blocks.map((b, i) => ({ index: i, src: b.src, format: b.format, nframe: b.nframe, start: b.startIndex })),
            },
        };
    },
    table(data): OpTable {
        const d = data as { nframe: number; blocks: { index: number; src: string; format: string; nframe: number; start: number }[] };
        return {
            title: `${d.nframe} frame(s)`,
            head: ['Block', 'File', 'Format', 'Frames', 'First frame'],
            rows: d.blocks.map((b) => [String(b.index), b.src, b.format, String(b.nframe), String(b.start)]),
        };
    },
});

export const removeTrajBlockOp = defineOp({
    name: TRAJ_OP.remove,
    description: 'Remove one block (one file\'s frames) from an MD trajectory. Blocks are numbered from 0 (list_traj_blocks).',
    params: {
        objId: objectId('Uid of the trajectory.', 'Trajectory'),
        index: integer('The block, from 0.'),
    },
    mutates: true,
    expose: EXPOSE,
    group: 'animation',
    describe: (a, n) => `Remove block ${a.index} of ${n('objId')}`,
    format: framesLine,
    run(ctx, args, oc) {
        return normalizeServiceResult(
            removeTrajectoryBlock(ctx, { sceneId: oc.sceneId, objId: args.objId, index: args.index }),
            'The block could not be removed.',
        );
    },
});

export const moveTrajBlockOp = defineOp({
    name: TRAJ_OP.move,
    description:
        'Move one block of an MD trajectory earlier or later, which reorders its frames. Blocks are numbered ' +
        'from 0 (list_traj_blocks).',
    params: {
        objId: objectId('Uid of the trajectory.', 'Trajectory'),
        index: integer('The block, from 0.'),
        by: integer('How many places to move it: negative earlier, positive later.'),
    },
    mutates: true,
    expose: EXPOSE,
    group: 'animation',
    describe: (a, n) => `Move block ${a.index} of ${n('objId')} by ${a.by}`,
    format: framesLine,
    run(ctx, args, oc) {
        return normalizeServiceResult(
            moveTrajectoryBlock(ctx, { sceneId: oc.sceneId, objId: args.objId, from: args.index, to: args.index + args.by }),
            'The block could not be moved.',
        );
    },
});

/** Every op this plugin adds. */
export const TRAJ_OPS: readonly AnyOp[] = [loadTrajectoryOp, addTrajBlockOp, listTrajBlocksOp, removeTrajBlockOp, moveTrajBlockOp];
