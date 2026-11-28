// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
//
// Loads an MD simulation trajectory as a block-centric Trajectory object
// (mdtools::Trajectory : AnimMol : MolCoord). Unlike loadObject (single
// reader -> single object), a trajectory is assembled from a topology file
// plus one or more coordinate-frame files:
//
//   1. Create an empty Trajectory.
//   2. Read the topology into it by attaching the topology ObjReader to the
//      pre-created Trajectory -- NOT to the reader's default MolCoord -- so the
//      atoms land on the Trajectory (which is itself a MolCoord). This mirrors
//      the C++ test makeWaterTrajectory() (test_trajio.cpp).
//   3. For each trajectory file, read a TrajBlock and append it to the
//      Trajectory. Frames concatenate in file order. Each block reader resolves
//      its parent Trajectory through targTrajUID, so the object must be added
//      to the scene (uid-resolvable) before the block reads run.
//   4. setupRenderer wires the initial renderer, reused unchanged from the
//      normal load-object flow (Trajectory is MolCoord-derived).
//
// Everything runs inside one undo txn. Trajectory::append validates that the
// block coordinate count matches the topology atom count; a mismatch throws
// and rolls the whole load back, surfaced to the command as an error dialog.
//
// The native objects are driven through raw scriptable methods, so their
// surfaces are described by the minimal local interfaces below (the generated
// wrapper types add nothing over these casts).
import { fileStem } from '@shared/fileExt';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes';
import { setupRenderer } from '@renderer/worker/server/services/rend/setupRenderer';
import { undoTxnResult } from '@renderer/worker/server/services/withUndoTxn';
import { OBJREADER_CATEGORY } from '@renderer/worker/server/services/helpers/pickReaderName';
import { fail, ok, type Result } from '@renderer/worker/shared/result';
import { appendTrajFile, applyLoadSel, fileExt, unsupportedTrajFormat } from './trajBlocks';
import { recordLoadTrajectory } from './recordTraj';
import { TOPOLOGY_READER_BY_EXT } from '../trajFormats';
import { baseName, reportTask } from '@renderer/worker/server/services/helpers/taskReport';

const log = console;


// Minimal native-object surfaces (all calls go through `as unknown as` casts).
interface ObjReaderHandle {
    setPath(path: string): void;
    attach(obj: unknown): void;
    read(): void;
    detach(): void;
    createDefaultObj(): unknown;
}

interface TrajObj {
    uid: number;
    name: string;
    append(block: unknown): void;
}

interface SceneHandle {
    addObject(obj: unknown): void;
}

export interface LoadTrajectoryArgs {
    sceneId: number;
    /** Topology file (.gro, or a topology-only .prmtop / .parm7 / .psf). */
    topologyPath: string;
    /** Coordinate / trajectory files in frame-concatenation order. */
    trajPaths: string[];
    /** Load every Nth frame (applied to every trajectory reader). Default 1. */
    nevery?: number;
    /** The block reader for every trajectory file; by default each file's extension picks one. */
    reader?: string | null;
    /** Keep only the atoms this selection picks (applied before the first block). */
    loadSel?: string | null;
    /** Initial renderer options (from the renderer dialog). */
    renderer: RendererOptions;
}

/** `{ objId }` of the new Trajectory on success. */
export type LoadTrajectoryResult = Result<{ objId: number }>;

export function loadTrajectory(
    ctx: WorkerContext,
    args: LoadTrajectoryArgs,
): LoadTrajectoryResult {
    log.info(
        `[worker] loading MD trajectory: topology=${args.topologyPath}, ${args.trajPaths.length} traj file(s)`,
    );

    if (!args.trajPaths.length) {
        log.warn('[worker] loadTrajectory: no trajectory files given');
        return fail('no trajectory files given', 'invalid-args');
    }
    const unsupported = unsupportedTrajFormat(args.trajPaths, args.reader);
    if (unsupported) return fail(unsupported, 'unsupported');
    // The topology reader by extension; a prmtop / PSF is read without
    // coordinates, so frame 0 is the first coordinate block.
    const topologyReader = TOPOLOGY_READER_BY_EXT[fileExt(args.topologyPath)];
    if (!topologyReader) {
        return fail(`unsupported topology format: ${args.topologyPath}`, 'unsupported');
    }

    const scene = ctx.sceMgr.getScene(args.sceneId);
    if (!scene) {
        log.warn(`[worker] loadTrajectory: scene ${args.sceneId} not found`);
        return fail(`scene ${args.sceneId} not found`, 'not-found');
    }

    const nevery = args.nevery && args.nevery > 1 ? args.nevery : 1;

    // A throw inside (atom-count mismatch from the C++ reader, a missing
    // reader) rolls the transaction back and comes out as a Fail.
    return undoTxnResult(scene, 'Open MD trajectory', () => {
        // 1. Empty Trajectory object.
        const traj = ctx.svc.createObj('Trajectory') as unknown as TrajObj;
        if (!traj) return fail('failed to create Trajectory object', 'native');

        // 2. Topology -> Trajectory. Attach the topology reader to the
        //    pre-created Trajectory (not to createDefaultObj's MolCoord) so the
        //    atoms are read onto the Trajectory itself.
        const topoReader = ctx.strMgr.createHandler(
            topologyReader, OBJREADER_CATEGORY,
        ) as unknown as ObjReaderHandle | null;
        if (!topoReader) return fail(`topology reader "${topologyReader}" not available`, 'unsupported');
        // One step per file, each reported before its synchronous read
        // (long-task indicator): the topology, then every trajectory file.
        const total = 1 + args.trajPaths.length;
        reportTask(ctx, { label: 'Loading MD trajectory', detail: baseName(args.topologyPath), step: 1, total });
        topoReader.setPath(args.topologyPath);
        topoReader.attach(traj);
        topoReader.read();
        topoReader.detach();
        if (args.loadSel) applyLoadSel(ctx, args.sceneId, traj, args.loadSel);

        traj.name = args.renderer.objectName || fileStem(args.topologyPath);
        (scene as unknown as SceneHandle).addObject(traj);

        // 3. Trajectory files -> TrajBlocks appended in order.
        args.trajPaths.forEach((trajPath, i) => {
            reportTask(ctx, { detail: baseName(trajPath), step: 2 + i, total });
            appendTrajFile(ctx, traj, trajPath, nevery, args.reader);
        });

        // Before the renderer exists, so its default name is still free.
        recordLoadTrajectory(ctx, args.sceneId, {
            topology: args.topologyPath,
            paths: args.trajPaths,
            reader: args.reader ?? null,
            nevery,
            loadSel: args.loadSel ?? null,
            renderer: args.renderer,
        });

        // 4. Initial renderer (Trajectory is MolCoord-derived; reused as-is).
        setupRenderer(ctx, traj, args.renderer, true);

        return ok({ objId: traj.uid });
    });
}
