/**
 * @file worker/server/services/map/histogram.ts
 * @description The density histogram behind the panel's Level strip: the map
 * a contour renderer draws (its client object), rebinned onto the strip's
 * grid. Read-only; the reads themselves are shared with the multi-gradient
 * deck (`helpers/mapHistogram.ts`).
 */
import type { Renderer } from '@cuemol/core/src/wrappers/Renderer';
import type { Object as CueObject } from '@cuemol/core/src/wrappers/Object';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import {
    readHistogramFloorStats,
    readHistogramWithGlobalMax,
} from '@renderer/worker/server/services/helpers/mapHistogram';
import { fail, ok } from '@renderer/worker/shared/result';
import type {
    GetMapHistogramArgs,
    GetMapHistogramInfoArgs,
    GetMapHistogramInfoResult,
    GetMapHistogramResult,
} from './types';

/** The renderer's parent map (its client object); null when unresolvable. */
function resolveMapObj(
    ctx: WorkerContext,
    sceneId: number,
    rendId: number,
): CueObject | null {
    const scene = getSceneOrNull(ctx, sceneId);
    if (!scene) return null;
    try {
        const rend = scene.getRenderer(rendId) as Renderer | null;
        if (!rend) return null;
        const obj = (rend as unknown as { getClientObj?: () => CueObject | null }).getClientObj?.();
        return obj ?? null;
    } catch {
        return null;
    }
}

/** Rebinned histogram of the map renderer's parent map over [min, max]. */
export function getMapHistogram(
    ctx: WorkerContext,
    args: GetMapHistogramArgs,
): GetMapHistogramResult {
    const mapObj = resolveMapObj(ctx, args.sceneId, args.rendId);
    if (!mapObj) return fail('map renderer not found', 'not-found');
    const h = readHistogramWithGlobalMax(mapObj, args.min, args.max, args.nbins);
    if (!h) return fail('map has no histogram', 'unsupported');
    return ok(h);
}

/** The map's statistics for the strip's bin-width floor. */
export function getMapHistogramInfo(
    ctx: WorkerContext,
    args: GetMapHistogramInfoArgs,
): GetMapHistogramInfoResult {
    const mapObj = resolveMapObj(ctx, args.sceneId, args.rendId);
    if (!mapObj) return fail('map renderer not found', 'not-found');
    const { stats, voxelCount, peakCount } = readHistogramFloorStats(mapObj);
    return ok({ stats, voxelCount, peakCount });
}
