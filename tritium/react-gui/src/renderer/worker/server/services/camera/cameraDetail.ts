/**
 * @file renderer/worker/server/services/camera/cameraDetail.ts
 * @description The values the camera inspector shows of one camera.
 *
 * Read-only: the inspector edits a camera's name and visibility flags through
 * the existing services, and never its viewpoint. Runs in the Web Worker thread.
 */

import type { Camera } from '@cuemol/core/src/wrappers/Camera';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import { failFrom, fail, ok, type Result } from '@renderer/worker/shared/result';
import { CURRENT_CAMERA_NAME, type CameraDetail } from '@renderer/worker/shared/cameraTypes';

export interface GetCameraDetailArgs {
    sceneId: number;
    name: string;
}

export type GetCameraDetailResult = Result<{ detail: CameraDetail }>;

/**
 * Read one camera's values.
 *
 * @returns `not-found` when the scene or the camera is gone (the inspector
 *   then drops its target).
 */
export function getCameraDetail(ctx: WorkerContext, args: GetCameraDetailArgs): GetCameraDetailResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return fail(`scene ${args.sceneId} not found`, 'not-found');
    let cam: Camera | null;
    try {
        cam = (scene.getCameraRef(args.name) as Camera | null) ?? null;
    } catch {
        cam = null;
    }
    if (!cam) return fail(`no camera named "${args.name}"`, 'not-found');
    try {
        const c = cam.center;
        const q = cam.rotation;
        return ok({
            detail: {
                name: cam.name,
                src: cam.src ?? '',
                isCurrent: cam.name === CURRENT_CAMERA_NAME,
                visSize: cam.vis_size,
                center: [c.x, c.y, c.z],
                rotation: [q.x, q.y, q.z, q.a],
                zoom: cam.zoom,
                distance: cam.distance,
                slab: cam.slab,
                perspective: cam.perspec,
                // .qif enums arrive as their string ids at runtime.
                centerMark: String(cam.centerMark as unknown),
            },
        });
    } catch (e) {
        return failFrom(e, 'native');
    }
}
