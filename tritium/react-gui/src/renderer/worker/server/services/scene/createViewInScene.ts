// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { syncCurrentCam } from '@renderer/worker/server/services/camera/currentCam';
import { CURRENT_CAMERA_NAME } from '@renderer/worker/shared/cameraTypes';

export interface CreateViewInSceneArgs {
    sceneId: number;
    name?: string;
    inheritFromViewId?: number;
    dpr: number;
}

export interface CreateViewInSceneResult {
    ok: boolean;
    view_uid?: number;
}

export function createViewInScene(ctx: WorkerContext, args: CreateViewInSceneArgs): CreateViewInSceneResult {
    const { sceneId, name, inheritFromViewId, dpr } = args;

    const scene = ctx.sceMgr.getScene(sceneId);
    if (!scene) {
        return { ok: false };
    }

    // Save current view camera state before creating new view (UXP: saveViewToCam before createView)
    if (inheritFromViewId !== undefined) {
        syncCurrentCam(scene, inheritFromViewId);
    }

    const view = scene.createView();
    if (name) {
        view.name = name;
    }
    const view_uid = view.getUID();
    ctx.svc.addView(view_uid, dpr);

    // Restore camera state into the new view
    if (inheritFromViewId !== undefined) {
        scene.loadViewFromCam(view_uid, CURRENT_CAMERA_NAME);
    }

    return { ok: true, view_uid };
}
