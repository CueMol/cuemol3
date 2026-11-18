/**
 * @file h3-kit/gradient/GradientStopBar.tsx
 * @description Illustrator-style gradient stop bar: an optional histogram
 * strip, a gradient preview bar, a draggable stop-marker lane, and a
 * min/max label row.
 *
 * Controlled + CueMol-independent: the parent owns the stop list and all
 * writes. Interactions call back with a full replacement stop array:
 *   - drag a marker horizontally -> onDragStart / onPreview per frame /
 *     onCommit(stops, 'move') on release (keepRatio applies the UXP
 *     rescale; a vetoed frame keeps the previous preview),
 *   - drag a marker DELETE_DRAG_THRESHOLD_PX below the lane -> ghost
 *     preview, release deletes (onCommit(stops, 'delete')),
 *   - click empty lane space -> insert a stop with the interpolated color
 *     (onCommit(stops, 'add')),
 *   - Esc during a drag -> onAbort.
 *
 * Stops passed in may carry extra fields beyond { value, hex } (e.g. a
 * richer color string); edits spread the original objects so those fields
 * ride through onPreview / onCommit untouched. Only newly added stops are
 * bare { value, hex }.
 *
 * When `onDomainChange` is given, the histogram strip (HistogramStrip) supports view-range
 * gestures: trackpad pinch (a ctrlKey wheel in Chromium) zooms anchored
 * at the cursor, dragging pans with a grab cursor, and a horizontal
 * two-finger scroll (wheel deltaX) pans. The histogram bins carry the
 * domain they were fetched for, so during a gesture the existing bars are
 * remapped onto the new view domain until the debounced refetch lands.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    DELETE_DRAG_THRESHOLD_PX,
    DRAG_THRESHOLD_PX,
    type GradientHistogram,
    type GradientStop,
    type ValueDomain,
    gradientCssStops,
    hitTestStop,
    interpolateHexAt,
    keepRatioRescale,
    moveStopFree,
    valueToX,
    xToValue,
} from './gradientGeometry'
import { HistogramStrip } from './HistogramStrip'

/** Gesture kind reported by onCommit. */
export type GradientCommitGesture = 'move' | 'add' | 'delete'

interface GradientStopBarProps {
    /** Stop list sorted ascending by value. Extra fields are preserved. */
    stops: readonly GradientStop[]
    /**
     * Display value range for the whole bar (histogram / gradient /
     * markers / labels). Owned by the parent so it can extend beyond the
     * stop range (zoom) and stay frozen during a drag. Stops outside the
     * domain pin at the lane edges.
     */
    domain: ValueDomain
    /** Selected stop index, or null. */
    selectedIndex: number | null
    /** Histogram strip data; null hides the strip (UXP collapse parity). */
    histogram: GradientHistogram | null
    /** Apply the UXP keep-ratio rescale while dragging. */
    keepRatio: boolean
    disabled?: boolean
    onSelect: (index: number | null) => void
    /** A horizontal/vertical drag crossed the threshold (snapshot point). */
    onDragStart: () => void
    /** Per-frame preview during a drag. */
    onPreview: (stops: GradientStop[]) => void
    /** Final stop set on release / click-add. */
    onCommit: (stops: GradientStop[], gesture: GradientCommitGesture) => void
    /** Esc pressed during a drag. */
    onAbort: () => void
    /**
     * Enables histogram view-range gestures (pinch zoom / drag pan /
     * horizontal-wheel pan). Called with the full replacement domain.
     */
    onDomainChange?: (domain: ValueDomain) => void
    /**
     * Reports the bar's CSS pixel width (on mount and resize) so the
     * parent can size the histogram bin count to the strip.
     */
    onWidthChange?: (widthPx: number) => void
}

/** Live drag bookkeeping (kept in a ref; renders go through props). */
interface DragState {
    index: number
    startX: number
    startY: number
    /** Domain is frozen at drag start so the lane does not re-scale mid-drag. */
    min: number
    max: number
    started: boolean
    deleteArmed: boolean
    /** Last previewed stop set (the commit payload on release). */
    lastStops: GradientStop[]
    /** Original stop set at drag start (for vetoed keep-ratio frames). */
    origStops: GradientStop[]
}

/**
 * The gradient stop bar widget. See the file header for the interaction
 * contract.
 */
export const GradientStopBar: React.FC<GradientStopBarProps> = ({
    stops,
    domain,
    selectedIndex,
    histogram,
    keepRatio,
    disabled,
    onSelect,
    onDragStart,
    onPreview,
    onCommit,
    onAbort,
    onDomainChange,
    onWidthChange,
}) => {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const laneRef = useRef<HTMLDivElement | null>(null)
    const dragRef = useRef<DragState | null>(null)
    /** Marker index currently ghosted by a delete-armed drag. */
    const [ghostIndex, setGhostIndex] = useState<number | null>(null)
    const onWidthChangeRef = useRef(onWidthChange)
    onWidthChangeRef.current = onWidthChange

    // Report the bar width so the parent can size the bin count. The root
    // is always mounted (unlike the histogram strip), so the first report
    // arrives before the first histogram fetch settles.
    useEffect(() => {
        const el = rootRef.current
        if (!el || !onWidthChangeRef.current) return
        const report = () => onWidthChangeRef.current?.(el.clientWidth)
        const ro = new ResizeObserver(report)
        ro.observe(el)
        report()
        return () => ro.disconnect()
    }, [])

    // --- drag lifecycle ---

    const finishDrag = useCallback(() => {
        dragRef.current = null
        setGhostIndex(null)
    }, [])

    const handleMarkerMouseDown = useCallback(
        (index: number, e: React.MouseEvent) => {
            if (e.button !== 0 || disabled) return
            e.preventDefault()
            e.stopPropagation()
            onSelect(index)
            const lane = laneRef.current
            if (!lane) return

            const drag: DragState = {
                index,
                startX: e.clientX,
                startY: e.clientY,
                min: domain.min,
                max: domain.max,
                started: false,
                deleteArmed: false,
                lastStops: [...stops],
                origStops: [...stops],
            }
            dragRef.current = drag

            const onMove = (ev: MouseEvent) => {
                const d = dragRef.current
                if (!d) return
                const dx = ev.clientX - d.startX
                const dy = ev.clientY - d.startY
                if (
                    !d.started &&
                    Math.abs(dx) <= DRAG_THRESHOLD_PX &&
                    Math.abs(dy) <= DRAG_THRESHOLD_PX
                ) {
                    return
                }
                if (!d.started) {
                    d.started = true
                    onDragStart()
                }

                // Vertical pull below the lane arms deletion (needs >= 2
                // stops; deleting the last one via drag is not offered).
                const laneRect = lane.getBoundingClientRect()
                const deleteArmed =
                    d.origStops.length >= 2 &&
                    ev.clientY - laneRect.bottom > DELETE_DRAG_THRESHOLD_PX
                if (deleteArmed !== d.deleteArmed) {
                    d.deleteArmed = deleteArmed
                    setGhostIndex(deleteArmed ? d.index : null)
                }
                if (deleteArmed) {
                    const next = d.origStops.filter((_, i) => i !== d.index)
                    d.lastStops = next
                    onPreview(next)
                    return
                }

                // Horizontal move within the frozen domain.
                const width = laneRect.width
                const x0 = valueToX(
                    d.origStops[d.index].value, d.min, d.max, width,
                )
                const newValue = xToValue(x0 + dx, d.min, d.max, width)
                const values = d.origStops.map((s) => s.value)
                if (keepRatio) {
                    const rescaled = keepRatioRescale(values, d.index, newValue)
                    // Vetoed frame: keep the previous preview.
                    if (rescaled === null) return
                    const next = d.origStops.map((s, i) => ({
                        ...s,
                        value: rescaled[i],
                    }))
                    d.lastStops = next
                    onPreview(next)
                } else {
                    const { values: moved, index: newIdx } = moveStopFree(
                        values, d.index, newValue,
                    )
                    // Rebuild the stop list in the new order: the moved stop
                    // keeps its payload, the others shift around it.
                    const others = d.origStops.filter((_, i) => i !== d.index)
                    const next: GradientStop[] = []
                    let oi = 0
                    for (let i = 0; i < moved.length; ++i) {
                        if (i === newIdx) {
                            next.push({
                                ...d.origStops[d.index],
                                value: moved[i],
                            })
                        } else {
                            next.push({ ...others[oi], value: moved[i] })
                            oi += 1
                        }
                    }
                    d.lastStops = next
                    onPreview(next)
                }
            }

            const onUp = () => {
                cleanup()
                const d = dragRef.current
                if (!d) return
                const wasDrag = d.started
                const armed = d.deleteArmed
                const payload = d.lastStops
                finishDrag()
                if (!wasDrag) return // bare click: selection already done
                if (armed) {
                    onSelect(null)
                    onCommit(payload, 'delete')
                } else {
                    onCommit(payload, 'move')
                }
            }

            const onKeyDown = (ev: KeyboardEvent) => {
                if (ev.key !== 'Escape') return
                const d = dragRef.current
                if (!d) return
                const wasDrag = d.started
                cleanup()
                finishDrag()
                if (wasDrag) onAbort()
            }

            const cleanup = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                document.removeEventListener('keydown', onKeyDown)
            }

            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
            document.addEventListener('keydown', onKeyDown)
        },
        [
            disabled, domain, stops, keepRatio,
            onSelect, onDragStart, onPreview, onCommit, onAbort, finishDrag,
        ],
    )

    /** Click on empty lane space: insert a stop at the pointer value. */
    const handleLaneMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.button !== 0 || disabled) return
            const lane = laneRef.current
            if (!lane) return
            const rect = lane.getBoundingClientRect()
            const x = e.clientX - rect.left
            const values = stops.map((s) => s.value)
            // Only VISIBLE markers claim the click: out-of-domain stops are
            // not rendered, so they must not swallow lane-edge clicks
            // (NaN never matches the hit test).
            const eps = (domain.max - domain.min) * 1e-9
            const visibleValues = values.map((v) =>
                v < domain.min - eps || v > domain.max + eps ? Number.NaN : v,
            )
            if (hitTestStop(visibleValues, x, domain.min, domain.max, rect.width) >= 0) {
                return // marker handles its own mousedown
            }
            const value = xToValue(x, domain.min, domain.max, rect.width)
            // an empty gradient has no color to interpolate; start white
            const hex = stops.length === 0
                ? '#FFFFFF'
                : interpolateHexAt(stops, value)
            const { values: merged, index } = moveStopFree(
                [...values, Number.NaN],
                values.length,
                value,
            )
            const others = [...stops]
            const next: GradientStop[] = []
            let oi = 0
            for (let i = 0; i < merged.length; ++i) {
                if (i === index) {
                    next.push({ value: merged[i], hex })
                } else {
                    next.push(others[oi])
                    oi += 1
                }
            }
            onSelect(index)
            onCommit(next, 'add')
        },
        [disabled, stops, domain, onSelect, onCommit],
    )

    const gradientCss = useMemo(
        () => gradientCssStops(stops, domain.min, domain.max),
        [stops, domain],
    )

    const fmt = (v: number) => v.toFixed(2)

    return (
        <div
            ref={rootRef}
            className={`mg-stopbar${disabled ? ' is-disabled' : ''}`}
        >
            {histogram !== null && (
                <HistogramStrip
                    histogram={histogram}
                    domain={domain}
                    disabled={disabled}
                    onDomainChange={onDomainChange}
                />
            )}
            <div className="mg-gradient-bar" style={{ background: gradientCss }} />
            <div
                ref={laneRef}
                className="mg-stop-lane"
                onMouseDown={handleLaneMouseDown}
            >
                {stops.map((s, i) => {
                    const span = domain.max - domain.min
                    // Out-of-domain stops are not rendered (they used to pin
                    // at the lane edges, hiding the true position AND eating
                    // lane-edge clicks). They stay editable via the selected
                    // -stop row and come back into view with Fit.
                    const eps = span * 1e-9
                    if (
                        span > 0 &&
                        (s.value < domain.min - eps || s.value > domain.max + eps)
                    ) {
                        return null
                    }
                    const pct = span <= 0
                        ? 50
                        : ((s.value - domain.min) / span) * 100
                    const cls =
                        'mg-stop-marker' +
                        (i === selectedIndex ? ' is-selected' : '') +
                        (i === ghostIndex ? ' is-ghost' : '')
                    return (
                        <div
                            key={i}
                            className={cls}
                            style={{ left: `${Math.min(100, Math.max(0, pct))}%` }}
                            data-index={i}
                            onMouseDown={(e) => handleMarkerMouseDown(i, e)}
                        >
                            <div className="mg-stop-pointer" />
                            <div
                                className="mg-stop-swatch"
                                style={{ background: s.hex }}
                            />
                        </div>
                    )
                })}
            </div>
            <div className="mg-minmax-row type-caption">
                <span>{fmt(domain.min)}</span>
                <span>{fmt(domain.max)}</span>
            </div>
        </div>
    )
}
