/**
 * @file h3-kit/gradient/useRebinnedHistogram.ts
 * @description Histogram strip data for a value domain, fetched through a
 * caller-supplied fetcher.
 *
 * Bins follow the d3/Vega convention: the bin width is snapped to the 1-2-5
 * "nice" ladder from the view span and the strip's pixel width (~3 px per
 * bar), and the fetched range is expanded to bin-width multiples (origin at
 * 0). Two overlapping views at the same zoom level therefore share identical
 * bin edges, so a pan renders as a pure translation of the same bars -- and a
 * pan smaller than one bin does not refetch at all. The fetcher also returns
 * `globalNmax` (the max bin over the full value range on the same grid) so the
 * y-scale stays fixed while panning.
 *
 * Domain changes are debounced (~100 ms) so per-frame drag previews do not
 * refetch; callers additionally freeze the domain during a drag by passing
 * `paused: true`. Returns null when there is nothing to show.
 *
 * CueMol-independent: what is binned, and how, is the fetcher's business.
 * `sourceKey` names the data source; a change refetches even when the grid
 * did not move (e.g. another map renderer selected).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStaleGuard } from '@renderer/hooks/react/useStaleGuard'
import {
    alignedBinRange,
    histogramTargetBins,
    niceBinWidth,
    type BinGrid,
    type GradientHistogram,
    type ValueDomain,
} from './gradientGeometry'

const DOMAIN_DEBOUNCE_MS = 100

/** What a fetcher returns for one grid; null when unavailable. */
export interface RebinnedHistogramData {
    histo: number[]
    nmax: number
    globalNmax: number | null
}

export interface UseRebinnedHistogramOptions {
    /** Fetch the bins for one grid. Read through a ref: identity may change per render. */
    fetch: (grid: BinGrid) => Promise<RebinnedHistogramData | null>
    /** Identifies the data source; null idles the hook (reports null). */
    sourceKey: string | null
    /** View domain; null when there is nothing to show. */
    domain: ValueDomain | null
    /** Measured strip width in CSS px; 0/undefined -> default bin count. */
    widthPx?: number
    /**
     * Lower bound on the bin width in value units (see
     * `minHistogramBinWidth`). Zooming past it stops refining the bins and
     * simply widens the bars.
     */
    minBinWidth?: number
    /** True while a drag is in flight -- skips refetches. */
    paused?: boolean
}

/**
 * Fetch the rebinned histogram for the current view domain.
 * Returns null while unavailable (no source, no domain, or a failed fetch).
 */
export function useRebinnedHistogram({
    fetch,
    sourceKey,
    domain,
    widthPx,
    minBinWidth = 0,
    paused = false,
}: UseRebinnedHistogramOptions): GradientHistogram | null {
    const [histogram, setHistogram] = useState<GradientHistogram | null>(null)
    const guard = useStaleGuard()
    const fetchRef = useRef(fetch)
    fetchRef.current = fetch

    const min = domain?.min
    const max = domain?.max

    // Snap the request onto the nice, origin-aligned bin grid, never finer
    // than the data can support (`minBinWidth`).
    const grid = useMemo(() => {
        if (min === undefined || max === undefined || !(max > min)) return null
        const target = histogramTargetBins(widthPx ?? 0)
        const raw = Math.max((max - min) / target, minBinWidth)
        return alignedBinRange({ min, max }, niceBinWidth(raw))
    }, [min, max, widthPx, minBinWidth])

    useEffect(() => {
        if (paused) return
        if (sourceKey === null || grid === null) {
            setHistogram(null)
            return
        }
        const token = guard.next()
        const timer = setTimeout(() => {
            fetchRef.current(grid)
                .then((res) => {
                    if (!guard.isCurrent(token)) return
                    setHistogram(
                        res
                            ? {
                                bins: res.histo,
                                nmax: res.nmax,
                                globalNmax: res.globalNmax,
                                domain: { min: grid.min, max: grid.max },
                            }
                            : null,
                    )
                })
                .catch(() => {
                    if (!guard.isCurrent(token)) return
                    setHistogram(null)
                })
        }, DOMAIN_DEBOUNCE_MS)
        return () => clearTimeout(timer)
        // Keyed on the grid's values, not its identity: a pan within one bin
        // yields an equal grid and must not refetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paused, sourceKey, grid?.min, grid?.max, grid?.nbins, guard])

    return histogram
}
