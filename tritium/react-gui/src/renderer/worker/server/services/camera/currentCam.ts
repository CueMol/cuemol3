/**
 * @file renderer/worker/server/services/camera/currentCam.ts
 * @description The `__current` camera: the scene's live view point.
 *
 * It exists from the moment a scene is created, cannot be deleted, holds the
 * view state only (no visibility flags), and is not part of the undo history
 * (libcuemol2 `Scene::setCamera` / `destroyCamera` / `Camera::visAppend`
 * special-case it).
 *
 * Its value is refreshed from the active view right before something reads
 * it: saving a scene, exporting or rendering an image, adding a view,
 * starting an animation from it, writing it to a file. Every such write goes
 * through `syncCurrentCam`; a new reader of `__current` must call it first.
 * Runs in the Web Worker thread.
 */

import { CURRENT_CAMERA_NAME } from '@renderer/worker/shared/cameraTypes';

/** The slice of the Scene wrapper this module uses. */
interface SceneWithViewCam {
    saveViewToCam(viewId: number, name: string): boolean;
}

/**
 * Save the view's camera into `__current`.
 *
 * Safe inside or outside an undo transaction: C++ records nothing for
 * `__current`. A failure is swallowed (a camera problem must not stop a save
 * or an export) and reported as false.
 */
export function syncCurrentCam(scene: unknown, viewId: number): boolean {
    try {
        return (scene as SceneWithViewCam).saveViewToCam(viewId, CURRENT_CAMERA_NAME) !== false;
    } catch {
        return false;
    }
}

/** Whether `name` is the reserved `__current` (surrounding blanks ignored). */
export function isReservedCameraName(name: string): boolean {
    return name.trim() === CURRENT_CAMERA_NAME;
}

/** The error a camera service returns for the reserved name. */
export const RESERVED_CAMERA_ERROR = `"${CURRENT_CAMERA_NAME}" is reserved`;
