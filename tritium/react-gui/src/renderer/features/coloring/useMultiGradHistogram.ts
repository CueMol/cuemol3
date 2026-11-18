/**
 * @file features/coloring/useMultiGradHistogram.ts
 * @description Histogram strip data for the Multi-gradient deck: the
 * `getMultiGradHistogram` fetcher plugged into `useRebinnedHistogram`, which
 * owns the nice bin grid, the debounce, the drag pause and the stale guard.
 * Returns null when the map is unresolved (the strip is hidden, UXP collapse
 * parity).
 */

import { useCallback } from 'react'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import { useRebinnedHistogram } from '@renderer/h3-kit/gradient'
import type { BinGrid, GradientHistogram } from '@renderer/h3-kit/gradient'

export interface UseMultiGradHistogramOptions {
    cm: AsyncCueMol | null
    sceneId: number | undefined
    rendId: number | null
    /** What `rendId` names: a renderer (default) or an object. */
    targetKind?: 'renderer' | 'object'
    /** Which gradient: the renderer's own (default) or its B-factor coloring's. */
    gradient?: 'renderer' | 'coloring'
    /** View domain; null when there is nothing to show. */
    domain: { min: number; max: number } | null
    /** Measured strip width in CSS px; 0/undefined -> default bin count. */
    widthPx?: number
    /**
     * Lower bound on the bin width in density units (see
     * `minHistogramBinWidth`). Zooming past it stops refining the bins
     * and simply widens the bars.
     */
    minBinWidth?: number
    /** True while a drag is in flight -- skips refetches. */
    paused?: boolean
    /** When false the hook idles and reports null. */
    enabled?: boolean
}

/**
 * Fetch the rebinned histogram for the deck's current view domain.
 * Returns null while unavailable (no map, no domain, or disabled).
 */
export function useMultiGradHistogram({
    cm,
    sceneId,
    rendId,
    targetKind = 'renderer',
    gradient = 'renderer',
    domain,
    widthPx,
    minBinWidth = 0,
    paused = false,
    enabled = true,
}: UseMultiGradHistogramOptions): GradientHistogram | null {
    const fetch = useCallback(
        async (grid: BinGrid) => {
            if (!cm || sceneId === undefined || rendId === null) return null
            const res = await cm.invokeService('getMultiGradHistogram', {
                sceneId, rendId, targetKind, gradient,
                min: grid.min, max: grid.max, nbins: grid.nbins,
            })
            return res.ok
                ? { histo: res.histo, nmax: res.nmax, globalNmax: res.globalNmax ?? null }
                : null
        },
        [cm, sceneId, rendId, targetKind, gradient],
    )
    const ready = !!cm && enabled && sceneId !== undefined && rendId !== null
    return useRebinnedHistogram({
        fetch,
        sourceKey: ready ? `${sceneId}:${rendId}:${targetKind}:${gradient}` : null,
        domain,
        widthPx,
        minBinWidth,
        paused,
    })
}
