/**
 * @file worker/server/services/map/emDefaults.ts
 * @description Post-load adjustments for density maps opened through the
 * file-open dialog: the dialog's map-kind override (DensityMap `map_type`)
 * and the view policy (fit the views to the whole map, or bring the map's
 * display box to the view).
 *
 * The cryo-EM renderer defaults themselves are not written here: the map kind
 * picks the renderer's default style (`helpers/mapRendererStyles.ts`) and
 * `siglevel` is resolved by the map kind at draw time (top percent of grid
 * points on an EM map, the ChimeraX initial-contour rule), so a fresh EM
 * renderer starts at, and resets to, the top 1% level without any write.
 *
 * Runs in the Web Worker thread (sync C++ wrappers, no await). Every wrapper
 * access is duck-typed: the DensityMap-only members (`map_type_resolved`,
 * `fitView`) are probed before use so the helpers are no-ops for other
 * scalar objects.
 */
import type { FormatOptions, MapCenterPolicy } from '@renderer/worker/shared/fileOpenTypes';
import type { Scene } from '@cuemol/core/src/wrappers/Scene';
import type { View } from '@cuemol/core/src/wrappers/View';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { fitViewToMap } from './mapFit';
const log = console;

type Bag = Record<string, unknown>;

/**
 * Apply the dialog's map-kind override to a freshly read map.
 *
 * @param obj - the loaded object (a DensityMap for the ccp4map format)
 * @param format - the dialog's format options
 * @returns true when an override ('xtal' / 'em') was written
 */
export function applyMapTypeChoice(obj: unknown, format: FormatOptions): boolean {
    if (format.kind !== 'ccp4map') return false;
    const choice = format.options.mapType;
    if (choice !== 'xtal' && choice !== 'em') return false;
    const o = obj as Bag;
    if (typeof o.map_type_resolved !== 'string') return false;
    try {
        // enum props take their string id at runtime
        o.map_type = choice;
        return true;
    } catch (e) {
        log.warn('[worker] applyMapTypeChoice: map_type write failed:', e);
        return false;
    }
}

/**
 * True when `obj` is a DensityMap whose effective kind is cryo-EM.
 */
export function isEmDensityMap(obj: unknown): boolean {
    const o = obj as Bag;
    try {
        return typeof o.map_type_resolved === 'string' && o.map_type_resolved === 'em';
    } catch {
        return false;
    }
}

/**
 * Fit every view of the scene to the map as it is drawn (`mapFit.ts`: the
 * extent of its shown contours, else its data block).
 */
export function fitViewsToMap(ctx: WorkerContext, scene: Scene, obj: unknown): void {
    const o = obj as Bag & { fitView?: (view: View, dummy: boolean) => void };
    if (typeof o.fitView !== 'function') return;
    const uidStr = (scene as unknown as { view_uids?: string }).view_uids;
    if (!uidStr) return;
    for (const tok of uidStr.split(',')) {
        const uid = Number(tok.trim());
        if (!Number.isFinite(uid)) continue;
        try {
            const view = scene.getView(uid) as View | null;
            if (view) fitViewToMap(ctx, scene, obj, view);
        } catch (e) {
            log.warn(`[worker] fitViewsToMap: fitView failed for view ${uid}:`, e);
        }
    }
}

/**
 * Resolve `auto` against the map kind: a cryo-EM map is the whole subject and
 * its ORIGIN often puts it far from the camera, so the view goes to it; a
 * crystallographic map is read around a model already on screen, so the map's
 * display box comes to the view instead.
 *
 * UXP had no map kind and always defaulted to "Set map center"
 * (`fopen-renderopt-page.xul`), which is what a non-EM map still gets.
 */
function resolveMapCenterPolicy(
    obj: unknown,
    policy: MapCenterPolicy,
): Exclude<MapCenterPolicy, 'auto'> {
    if (policy !== 'auto') return policy;
    return isEmDensityMap(obj) ? 'moveViewCenter' : 'setMapCenter';
}

/**
 * Point the map's display box at where the user is already looking: the UXP
 * "Set map center" radio (`renderer.js`: `rend.center = view.getViewCenter()`).
 *
 * A fresh map renderer has `center` at the origin, which for a 2Fo-Fc map is
 * nowhere near the model, so without this the map draws an empty box. The
 * first view in the scene stands in for UXP's "current view": the load path
 * carries no view id, and a scene with several views has no better answer.
 */
function setMapCenterToView(scene: Scene, rend: unknown): boolean {
    const uidStr = (scene as unknown as { view_uids?: string }).view_uids;
    if (!uidStr) return false;
    const first = uidStr.split(',')[0]?.trim();
    const uid = Number(first);
    if (!Number.isFinite(uid)) return false;
    try {
        const view = scene.getView(uid) as View | null;
        if (!view) return false;
        return setRendCenterToView(view, rend);
    } catch (e) {
        log.warn('[worker] setMapCenterToView: view lookup failed:', e);
        return false;
    }
}

/** Point one map renderer's display box at `view`'s centre. */
function setRendCenterToView(view: View, rend: unknown): boolean {
    try {
        const center = (view as unknown as { getViewCenter(): unknown }).getViewCenter();
        if (!center) return false;
        (rend as Bag).center = center;
        return true;
    } catch (e) {
        log.warn('[worker] setRendCenterToView: center write failed:', e);
        return false;
    }
}

/**
 * Draw every renderer of a crystallographic map around `view`'s centre (the
 * "Set map center" policy), for a map fetched into a scene whose model is
 * already on screen: Get PDB loads the coordinates first and centres the view
 * on them, so the map comes to the model instead of the view going to the
 * unit cell.
 */
export function setMapRenderersCenterToView(obj: unknown, view: View): void {
    const o = obj as { getRendCount?: () => number; getRendererByIndex?: (i: number) => unknown };
    if (typeof o.getRendCount !== 'function' || typeof o.getRendererByIndex !== 'function') return;
    const n = o.getRendCount();
    for (let i = 0; i < n; ++i) {
        const rend = o.getRendererByIndex(i);
        if (rend) setRendCenterToView(view, rend);
    }
}

/**
 * Apply the dialog's view policy for a freshly loaded volume object.
 *
 * Called instead of the molecule recenter (`setupRenderer` skips volumes),
 * and after the object is read so `auto` can see the resolved map kind.
 *
 * @returns the policy that was actually applied, or null when the object is
 *   not a map the policy applies to.
 */
export function applyMapCenterPolicy(
    ctx: WorkerContext,
    scene: Scene,
    obj: unknown,
    rend: unknown,
    policy: MapCenterPolicy,
): Exclude<MapCenterPolicy, 'auto'> | null {
    // Only a DensityMap has both a map kind and a fitView; other scalar
    // objects (ElePotMap) keep the view where it is.
    if (typeof (obj as Bag).map_type_resolved !== 'string') return null;

    const resolved = resolveMapCenterPolicy(obj, policy);
    if (resolved === 'moveViewCenter') {
        fitViewsToMap(ctx, scene, obj);
    } else {
        setMapCenterToView(scene, rend);
    }
    return resolved;
}
