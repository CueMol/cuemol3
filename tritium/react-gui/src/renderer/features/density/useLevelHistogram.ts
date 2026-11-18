/**
 * @file features/density/useLevelHistogram.ts
 * @description The data behind the Density map pane's Level histogram: the
 * strip's view range, its bin-width floor, and the rebinned histogram of the
 * selected map renderer's parent map.
 *
 * The view range starts at the renderer's `uiAbsLevelRange` (background to the
 * top 0.01% of grid points -- the same range the Level field sweeps), so the
 * masked background of a cryo-EM map or an outlier maximum does not take up
 * the strip. It then follows the user's pan / zoom, returns to that range on
 * Fit, and starts over when another renderer is selected. It stays put during
 * a marker drag (`paused` also holds the refetch), so the axis never moves
 * under the marker.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import {
    minHistogramBinWidth,
    useRebinnedHistogram,
    type BinGrid,
    type GradientHistogram,
    type ValueDomain,
} from '@renderer/h3-kit/gradient'
import type {
    GetMapHistogramInfoResult,
    MapRendererState,
} from '@renderer/worker/server/services/map/map.service'

export interface UseLevelHistogramOptions {
    cm: AsyncCueMol | null
    sceneId: number | undefined
    rendId: number | undefined
    state: MapRendererState | null
    /** True while the marker is dragged: freezes the view and its refetch. */
    dragging: boolean
}

export interface LevelHistogram {
    histogram: GradientHistogram | null
    /** Null until the renderer's range (or the map's) is known. */
    domain: ValueDomain | null
    setDomain: (domain: ValueDomain) => void
    /** Reset the view range to the renderer's UI level range. */
    fit: () => void
    setWidthPx: (widthPx: number) => void
}

type InfoOk = Extract<GetMapHistogramInfoResult, { ok: true }>

/** `[lo, hi]` as a domain when both ends are finite and ordered. */
function asDomain(range: readonly [number, number] | undefined): ValueDomain | null {
    if (!range) return null
    const [lo, hi] = range
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { min: lo, max: hi } : null
}

/**
 * Level-histogram state for the selected map renderer. See the file header.
 */
export function useLevelHistogram({
    cm,
    sceneId,
    rendId,
    state,
    dragging,
}: UseLevelHistogramOptions): LevelHistogram {
    const [info, setInfo] = useState<InfoOk | null>(null)
    const [domain, setDomainState] = useState<ValueDomain | null>(null)
    const [widthPx, setWidthPx] = useState(0)

    // Per-map statistics: constant for a map, so once per renderer.
    useEffect(() => {
        setInfo(null)
        setDomainState(null)
        if (!cm || sceneId === undefined || rendId === undefined) return
        let cancelled = false
        cm.invokeService('getMapHistogramInfo', { sceneId, rendId })
            .then((res) => { if (!cancelled && res.ok) setInfo(res) })
            .catch(() => {})
        return () => { cancelled = true }
    }, [cm, sceneId, rendId])

    // The range the view starts from and Fit returns to.
    const homeDomain = useMemo((): ValueDomain | null => {
        const ui = asDomain(state?.uiAbsLevelRange)
        if (ui) return ui
        const s = info?.stats
        return s && s.max > s.min ? { min: s.min, max: s.max } : null
    }, [state?.uiAbsLevelRange, info])

    // First known range for this renderer becomes the view.
    useEffect(() => {
        if (domain === null && homeDomain !== null) setDomainState(homeDomain)
    }, [domain, homeDomain])

    const setDomain = useCallback(
        (next: ValueDomain) => {
            if (dragging) return
            // Same guard as the multigrad deck: never collapse to zero width.
            if (next.max > next.min) setDomainState(next)
        },
        [dragging],
    )

    const fit = useCallback(() => {
        if (homeDomain) setDomainState(homeDomain)
    }, [homeDomain])

    const minBinWidth = useMemo(() => {
        const s = info?.stats
        if (!s) return 0
        return minHistogramBinWidth({
            sigma: s.sigma,
            min: s.min,
            max: s.max,
            voxelCount: info?.voxelCount ?? null,
            peakCount: info?.peakCount ?? null,
            quantStep: s.quantStep,
        })
    }, [info])

    const fetch = useCallback(
        async (grid: BinGrid) => {
            if (!cm || sceneId === undefined || rendId === undefined) return null
            const res = await cm.invokeService('getMapHistogram', {
                sceneId, rendId, min: grid.min, max: grid.max, nbins: grid.nbins,
            })
            return res.ok ? { histo: res.histo, nmax: res.nmax, globalNmax: res.globalNmax } : null
        },
        [cm, sceneId, rendId],
    )

    const histogram = useRebinnedHistogram({
        fetch,
        sourceKey: cm && sceneId !== undefined && rendId !== undefined ? `${sceneId}:${rendId}` : null,
        domain,
        widthPx,
        minBinWidth,
        paused: dragging,
    })

    return { histogram, domain, setDomain, fit, setWidthPx }
}

