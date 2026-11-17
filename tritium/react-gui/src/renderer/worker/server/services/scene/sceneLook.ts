// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
/**
 * @file worker/server/services/scene/sceneLook.ts
 * @description Read and switch a scene's look (see `worker/shared/sceneLook`).
 *
 * The CueMol3 look is the read-only scene style set `cuemol3_look`, loaded
 * from `%%CONFDIR%%/data/cuemol3_look.xml` at the END of the scene's sets (the
 * lowest priority), so a set the user makes in the scene -- which goes to the
 * front -- overrides it. Removing the set gives the CueMol2 look.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import { fail, failFrom, ok, type Result } from '@renderer/worker/shared/result';
import { isValidUid } from '@renderer/worker/shared/uid';
import {
    CUEMOL3_LOOK_SET,
    CUEMOL3_LOOK_SRC,
    isSceneLook,
    type SceneLook,
} from '@renderer/worker/shared/sceneLook';
import { undoTxnResult } from '../withUndoTxn';

/** The uid of the scene's look set, or 0 (invalid) when it has none. */
function lookSetUid(ctx: WorkerContext, sceneId: number): number {
    return ctx.styleMgr.hasStyleSet(CUEMOL3_LOOK_SET, sceneId);
}

/** The look of scene `sceneId`, from whether it has the look set. */
export function sceneLookOf(ctx: WorkerContext, sceneId: number): SceneLook {
    try {
        return isValidUid(lookSetUid(ctx, sceneId)) ? 'cuemol3' : 'cuemol2';
    } catch {
        return 'cuemol2';
    }
}

/**
 * Load the look set into a scene, at the lowest priority, read-only.
 * Records an undo step when called inside a txn.
 */
export function addLookSet(ctx: WorkerContext, sceneId: number): void {
    ctx.styleMgr.loadStyleSetFromFileAt(sceneId, CUEMOL3_LOOK_SRC, true, true);
}

export interface SceneLookArgs {
    sceneId: number;
}

export type GetSceneLookResult = Result<{ look: SceneLook }>;

/** The look of a scene. */
export function getSceneLook(ctx: WorkerContext, args: SceneLookArgs): GetSceneLookResult {
    if (!getSceneOrNull(ctx, args.sceneId)) return fail('scene not found', 'not-found');
    return ok({ look: sceneLookOf(ctx, args.sceneId) });
}

export interface SetSceneLookArgs {
    sceneId: number;
    look: SceneLook;
}

export type SetSceneLookResult = Result<{ look: SceneLook }>;

/**
 * Switch a scene's look, as one undo step. The scene's renderers resolve
 * their styles by name, so they redraw with the new look at once; molecules
 * already painted keep their colours.
 */
export function setSceneLook(ctx: WorkerContext, args: SetSceneLookArgs): SetSceneLookResult {
    if (!isSceneLook(args.look)) return fail(`unknown look: ${String(args.look)}`, 'invalid-args');
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return fail('scene not found', 'not-found');
    if (sceneLookOf(ctx, args.sceneId) === args.look) return ok({ look: args.look });

    const res = undoTxnResult(scene, 'Change scene look', (): SetSceneLookResult => {
        try {
            if (args.look === 'cuemol3') {
                addLookSet(ctx, args.sceneId);
            } else {
                // An embedded look (from a qsc saved for an older version) is
                // found by name as well, and removed the same way.
                if (!ctx.styleMgr.destroyStyleSet(args.sceneId, lookSetUid(ctx, args.sceneId))) {
                    return fail('could not remove the look style set', 'native');
                }
            }
        } catch (e) {
            return failFrom(e, 'io');
        }
        return ok({ look: args.look });
    });
    if (res.ok) {
        try { ctx.styleMgr.firePendingEvents(); } catch { /* ignore */ }
    }
    return res;
}
