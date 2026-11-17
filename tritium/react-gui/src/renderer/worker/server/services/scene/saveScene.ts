// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
import type { SceneXMLWriter } from '@cuemol/core/src/wrappers/SceneXMLWriter';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import { syncCurrentCam } from '@renderer/worker/server/services/camera/currentCam';

export interface GetSceneSaveInfoArgs {
    sceneId: number;
}

export interface GetSceneSaveInfoResult {
    ok: boolean;
    src: string;
    name: string;
    srctype: string;
}

export interface SaveSceneOptions {
    embedAll?: boolean;
    compress?: string;
    base64?: boolean;
    version?: string;
    /** Target app version ('2.2' | '2.3' | '3.0'); see the writer's `compat`. */
    compat?: string;
}

export interface SaveSceneArgs {
    sceneId: number;
    viewId: number;
    filePath: string;
    options?: SaveSceneOptions;
}

export interface SaveSceneResult {
    ok: boolean;
}

function basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? p;
}

export function getSceneSaveInfo(
    ctx: WorkerContext,
    args: GetSceneSaveInfoArgs,
): GetSceneSaveInfoResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false, src: '', name: '', srctype: '' };
    return {
        ok: true,
        src: scene.src ?? '',
        name: scene.name ?? '',
        srctype: scene.srctype ?? '',
    };
}

export function saveScene(ctx: WorkerContext, args: SaveSceneArgs): SaveSceneResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false };

    // UXP parity (qsc-io.writeSceneFile): persist the current view into the
    // "__current" camera before serialising; a failure does not stop the save.
    syncCurrentCam(scene, args.viewId);

    const writer = ctx.strMgr.createHandler('qsc_xml', 4) as SceneXMLWriter;
    writer.setDefaultOpts(scene);
    // The C++ default target is the oldest version (an application style set
    // such as `cuemol3_look` is embedded). CueMol3 writes for itself unless
    // the scene remembers another choice (or the caller passes one).
    if (!writer.compat) writer.compat = '3.0';

    const o = args.options;
    if (o) {
        if (o.embedAll !== undefined) writer.embedAll = o.embedAll;
        // compress is declared as enum in .qif but accepts a string ID at
        // runtime; cast follows the convention noted in tritium/CLAUDE.md.
        if (o.compress !== undefined) writer.compress = o.compress as unknown as number;
        if (o.base64 !== undefined) writer.base64 = o.base64;
        if (o.version !== undefined) writer.version = o.version;
        if (o.compat !== undefined) writer.compat = o.compat;
    }

    writer.attach(scene);
    try {
        writer.setPath(args.filePath);
        writer.write();
    } finally {
        // A failed write (read-only path, disk full) used to leave the writer
        // attached to the scene. objectSave.saveObjectToFile already does this.
        writer.detach();
    }

    // UXP: writing the scene drops undo/redo data. Also align the displayed
    // scene name with the new file name (matches the Save As path in UXP).
    scene.clearUndoData();
    scene.setName(basename(args.filePath));

    return { ok: true };
}
