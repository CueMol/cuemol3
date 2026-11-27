// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
/**
 * @file worker/server/services/rend/requiredRenderer.ts
 * @description Whether a load can create the renderer its caller named, asked
 * of the object just read and before it is added to the scene.
 *
 * C++ does not refuse a mismatch on its own: `createPresetRenderer` checks
 * only that the style is some `-rendpreset`, and `createRenderer` registers a
 * type the object cannot draw (a `cartoon` on a density map). So the lists
 * the file-open dialog offers are the rule here too. Checking before
 * `addObject` matters under an outer undo transaction (an agent turn): a
 * nested rollback does not take the object back out, so a load that fails
 * must not have touched the scene.
 */

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes';
import { fail, type Fail } from '@renderer/worker/shared/result';
import { isInitialRendererType } from '@renderer/worker/server/services/helpers/rendererFilter';
import { safeRead } from '@renderer/worker/server/services/helpers/safeRead';
import { collectRendPresetTypes } from './getNewRendererOptions';

/** What an object reports about the renderers it can have. */
interface RendererCapable {
    getClassName(): string;
    searchCompatibleRendererNames(): string;
}

/**
 * The renderer types an object may start with, as the file-open dialog
 * offers them: its compatible types without the internal `*group` and the
 * types that come up empty at load (`isInitialRendererType`).
 */
export function initialRendererTypes(obj: unknown): string[] {
    const text = safeRead(() => (obj as RendererCapable).searchCompatibleRendererNames()) ?? '';
    return text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && isInitialRendererType(s));
}

/**
 * Why `obj` cannot get the renderer `rendOpts` names, or null when it can.
 *
 * @param sceneId - the scene it will join (its local presets count too)
 */
export function requiredRendererError(
    ctx: WorkerContext,
    sceneId: number,
    obj: unknown,
    rendOpts: RendererOptions,
): string | null {
    if (rendOpts.presetName) {
        const className = safeRead(() => (obj as RendererCapable).getClassName()) ?? '';
        const presets = collectRendPresetTypes(ctx, sceneId, className).map((p) => p.name);
        if (presets.includes(rendOpts.presetName)) return null;
        return `This object has no renderer preset "${rendOpts.presetName}". Available: ${presets.join(', ') || 'none'}.`;
    }
    const types = initialRendererTypes(obj);
    if (types.includes(rendOpts.rendererType)) return null;
    return `This object cannot be drawn as "${rendOpts.rendererType}". Available: ${types.join(', ') || 'none'}.`;
}

/**
 * Take back an object whose required renderer could not be created after
 * all (the check passed, the creation failed): removed explicitly, since
 * under an outer transaction the rollback alone would leave it in the scene.
 */
export function removeUnrendered(scene: unknown, obj: unknown): Fail {
    const uid = safeRead(() => (obj as { uid: number }).uid);
    if (uid !== undefined) safeRead(() => (scene as { destroyObject(id: number): boolean }).destroyObject(uid));
    return fail('The renderer could not be created.', 'native');
}
