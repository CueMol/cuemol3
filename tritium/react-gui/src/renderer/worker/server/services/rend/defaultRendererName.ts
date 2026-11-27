/**
 * @file worker/server/services/rend/defaultRendererName.ts
 * @description The name a new renderer gets when nobody chose one: the first
 * of `<prefix>1`, `<prefix>2`, ... that no renderer in the scene is named.
 *
 * One rule for every path that creates a renderer -- the File Open / New
 * Renderer dialogs (`proposeUniqName` kind `sceneRenderer`), `add_renderer`
 * and the load / fetch ops -- so the same steps done in the GUI and in the
 * console give the same names. Names are unique scene-wide (not per object):
 * renderers are also looked up by name across the scene
 * (`Scene.getRendByName`).
 */
import { presetNamePrefix } from '@renderer/worker/shared/fileOpenDefaults';

/** The scene lookup the rule probes. */
export interface RendNameScope {
    getRendByName(name: string): unknown;
}

/** The first `<prefix><n>` (n = 1, 2, ...) no renderer in the scene is named. */
export function unusedSceneRendererName(scene: RendNameScope, prefix: string): string {
    for (let i = 1; i < 10000; i++) {
        const candidate = `${prefix}${i}`;
        if (!scene.getRendByName(candidate)) return candidate;
    }
    return `${prefix}${Date.now()}`;
}

/**
 * The default name of a renderer about to be created: a preset group is
 * numbered after its preset (`default1_1`), a plain renderer after its type.
 */
export function defaultRendererName(
    scene: RendNameScope,
    r: { presetName?: string; rendererType: string },
): string {
    return unusedSceneRendererName(scene, r.presetName ? presetNamePrefix(r.presetName) : r.rendererType);
}
