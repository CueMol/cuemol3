/**
 * @file worker/server/services/helpers/mapHistogram.ts
 * @description Histogram reads off a scalar map object (DensityMap /
 * ElePotMap), shared by the multi-gradient deck (the map a renderer is
 * coloured by) and the density map panel (the map a contour renderer draws).
 *
 * The C++ side keeps one fine base histogram per map; `getHistogramJSON`
 * rebins it onto any requested grid, so every read here is a cheap rebin.
 */

import type { Object as CueObject } from '@cuemol/core/src/wrappers/Object';
import type { MultiGradMapStats } from '@renderer/worker/server/services/coloring/types';

/**
 * Upper bound on the full-range rebin used for `globalNmax`. Only an extreme
 * zoom-in (bin width thousands of times finer than the map range) exceeds
 * it; the caller then falls back to the window max.
 */
const GLOBAL_NMAX_BIN_CAP = 65536;

/** Bin count of the full-range pass that measures the voxel totals. */
const FLOOR_STATS_NBINS = 256;

function safeReadNumber(obj: unknown, prop: string): number | null {
    try {
        const v = (obj as Record<string, unknown>)[prop];
        return typeof v === 'number' ? v : null;
    } catch {
        return null;
    }
}

/** Read the den_* stats off a scalar map; null when any is unreadable. */
export function readMapStats(obj: CueObject): MultiGradMapStats | null {
    const min = safeReadNumber(obj, 'den_min');
    const max = safeReadNumber(obj, 'den_max');
    const mean = safeReadNumber(obj, 'den_mean');
    const sigma = safeReadNumber(obj, 'den_sigma');
    if (min === null || max === null || mean === null || sigma === null) {
        return null;
    }
    // Unlike the four stats above, a missing quant step is non-fatal: it only
    // relaxes a bin-width floor, so it degrades to 0 (continuous) instead of
    // failing the whole read.
    const quantStep = safeReadNumber(obj, 'den_quant_step') ?? 0;
    return { min, max, mean, sigma, quantStep };
}

/**
 * Read a rebinned histogram off a map object; null when the object lacks
 * `getHistogramJSON` or the payload is malformed.
 *
 * The returned JSON's own min/max describe the object's full range and are
 * ignored; `nmax` is the max bin count within the requested range.
 */
export function readHistogramRange(
    mapObj: CueObject,
    min: number,
    max: number,
    nbins: number,
): { histo: number[]; nmax: number } | null {
    const getHisto = (mapObj as unknown as {
        getHistogramJSON?: (min: number, max: number, nbins: number) => string;
    }).getHistogramJSON;
    if (typeof getHisto !== 'function') return null;
    let parsed: { histo?: unknown; nmax?: unknown };
    try {
        parsed = JSON.parse(getHisto.call(mapObj, min, max, nbins));
    } catch {
        return null;
    }
    if (!Array.isArray(parsed.histo)) return null;
    return {
        histo: parsed.histo.filter(
            (v): v is number => typeof v === 'number',
        ),
        nmax: typeof parsed.nmax === 'number' ? parsed.nmax : 0,
    };
}

/**
 * The window [min, max] in `nbins` bins, plus `globalNmax`: the max bin over
 * the map's full density range rebinned on the SAME grid (bin width and
 * origin-0 alignment), so the strip's y-scale stays fixed while panning.
 * `globalNmax` is null when the full range is unreadable or too fine to
 * rebin (GLOBAL_NMAX_BIN_CAP). Null when the window itself is unreadable.
 */
export function readHistogramWithGlobalMax(
    mapObj: CueObject,
    min: number,
    max: number,
    nbins: number,
): { histo: number[]; nmax: number; globalNmax: number | null } | null {
    const h = readHistogramRange(mapObj, min, max, nbins);
    if (!h) return null;
    let globalNmax: number | null = null;
    const binWidth = (max - min) / nbins;
    const stats = readMapStats(mapObj);
    if (stats && stats.max > stats.min && binWidth > 0) {
        const i0 = Math.floor(stats.min / binWidth + 1e-9);
        const i1 = Math.ceil(stats.max / binWidth - 1e-9);
        const nbinsFull = i1 - i0;
        if (nbinsFull > 0 && nbinsFull <= GLOBAL_NMAX_BIN_CAP) {
            const full = readHistogramRange(
                mapObj, i0 * binWidth, i1 * binWidth, nbinsFull,
            );
            if (full) globalNmax = full.nmax;
        }
    }
    return { ...h, globalNmax };
}

/**
 * The per-map statistics that bound how fine the display bins can usefully
 * get (`minHistogramBinWidth`): the den_* stats plus the voxel total and the
 * peak bin of one full-range pass.
 */
export function readHistogramFloorStats(mapObj: CueObject): {
    stats: MultiGradMapStats | null;
    voxelCount: number | null;
    peakCount: number | null;
    /** The full-range pass itself, for callers that derive more from it. */
    fullHisto: number[] | null;
} {
    const stats = readMapStats(mapObj);
    if (!stats || !(stats.max > stats.min)) {
        return { stats, voxelCount: null, peakCount: null, fullHisto: null };
    }
    const h = readHistogramRange(mapObj, stats.min, stats.max, FLOOR_STATS_NBINS);
    if (!h) return { stats, voxelCount: null, peakCount: null, fullHisto: null };
    return {
        stats,
        voxelCount: h.histo.reduce((a, b) => a + b, 0),
        peakCount: h.nmax,
        fullHisto: h.histo,
    };
}
