/**
 * @file h3-kit/gradient/HistogramStrip.tsx
 * @description The histogram strip shared by the gradient stop bar and the
 * level histogram: a log-scaled bar chart of a value distribution drawn on a
 * HiDPI canvas, with optional view-range gestures and an overlay slot.
 *
 * View-range gestures (enabled by `onDomainChange`): trackpad pinch (a
 * ctrlKey wheel in Chromium) zooms anchored at the cursor, a horizontal
 * two-finger scroll pans, and dragging pans with a grab cursor. The bins
 * carry the domain they were fetched for, so during a gesture the existing
 * bars are remapped onto the new view domain until the caller's refetch lands.
 *
 * With `onClickValue`, a press released without moving past
 * DRAG_THRESHOLD_PX is a click and reports the value under the pointer; only
 * a move past the threshold starts a pan. Without it, a press pans at once.
 *
 * `children` render inside the strip box (position: relative), on top of the
 * canvas -- e.g. a level marker. An overlay that handles its own mousedown
 * must stop propagation so the strip does not also pan.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
    DRAG_THRESHOLD_PX,
    type GradientHistogram,
    type ValueDomain,
    histogramBarFraction,
    xToValue,
} from './gradientGeometry'

void React // classic JSX runtime (vitest)

/** Strip height in CSS px (matches `.mg-histo`). */
export const HISTO_HEIGHT_PX = 48

/** exp() scale per wheel deltaY unit for the pinch zoom. */
const PINCH_ZOOM_K = 0.01

interface HistogramStripProps {
    histogram: GradientHistogram
    /** View domain the bars are drawn in. */
    domain: ValueDomain
    disabled?: boolean
    /** Enables the view-range gestures. Called with the full replacement domain. */
    onDomainChange?: (domain: ValueDomain) => void
    /** Enables click-to-value: a press released without moving reports its value. */
    onClickValue?: (value: number) => void
    /** Extra class on the strip box. */
    className?: string
    children?: React.ReactNode
}

/**
 * Size a canvas's backing store for the devicePixelRatio (local copy of the
 * SequencePanel helper; see that file for the reallocation-guard rationale).
 */
function setupHiDpiCanvas(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
): CanvasRenderingContext2D | null {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const wantW = Math.max(1, Math.floor(cssWidth * dpr))
    const wantH = Math.max(1, Math.floor(cssHeight * dpr))
    if (canvas.width !== wantW) canvas.width = wantW
    if (canvas.height !== wantH) canvas.height = wantH
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
}

/** Resolve a :root CSS custom property with a non-DOM fallback. */
function readCssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback
    const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim()
    return v || fallback
}

/**
 * The histogram strip. See the file header for the gesture contract.
 */
export const HistogramStrip: React.FC<HistogramStripProps> = ({
    histogram,
    domain,
    disabled,
    onDomainChange,
    onClickValue,
    className,
    children,
}) => {
    const boxRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const [width, setWidth] = useState(0)
    /** True while a pan drag is active (grabbing cursor). */
    const [panning, setPanning] = useState(false)

    // Latest domain / callbacks for the natively-attached listeners (kept in
    // refs so the wheel listener attaches once per strip).
    const domainRef = useRef(domain)
    domainRef.current = domain
    const onDomainChangeRef = useRef(onDomainChange)
    onDomainChangeRef.current = onDomainChange
    const onClickValueRef = useRef(onClickValue)
    onClickValueRef.current = onClickValue

    useEffect(() => {
        const el = boxRef.current
        if (!el) return
        const ro = new ResizeObserver(() => setWidth(el.clientWidth))
        ro.observe(el)
        setWidth(el.clientWidth)
        return () => ro.disconnect()
    }, [])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || width <= 0) return
        const ctx = setupHiDpiCanvas(canvas, width, HISTO_HEIGHT_PX)
        if (!ctx) return
        ctx.clearRect(0, 0, width, HISTO_HEIGHT_PX)
        const { bins, nmax, globalNmax, domain: fetched } = histogram
        // Fixed LOG y-scale: bar heights are log(1+n) normalized against the
        // map-wide max on the same grid, so a dominant bin (e.g. the zero
        // peak of a solvent-flattened map) cannot flatten the rest and
        // panning does not rescale the bars. Falls back to the window max
        // when the map-wide max is unavailable.
        const yMax = globalNmax !== null && globalNmax > 0 ? globalNmax : nmax
        if (bins.length === 0 || yMax <= 0) return
        const fspan = fetched.max - fetched.min
        const vspan = domain.max - domain.min
        if (!(fspan > 0) || !(vspan > 0)) return
        ctx.fillStyle = readCssVar('--text-muted', '#939ba6')
        // Bars are mapped from the domain they were FETCHED for onto the
        // CURRENT view domain, so pan/zoom gestures move the existing bars
        // immediately; the debounced refetch then replaces the data.
        const binw = fspan / bins.length
        for (let i = 0; i < bins.length; ++i) {
            const frac = histogramBarFraction(bins[i], yMax)
            if (frac <= 0) continue
            const v0 = fetched.min + i * binw
            const x0 = ((v0 - domain.min) / vspan) * width
            const x1 = ((v0 + binw - domain.min) / vspan) * width
            if (x1 < 0 || x0 > width) continue
            const h = frac * HISTO_HEIGHT_PX
            ctx.fillRect(x0, HISTO_HEIGHT_PX - h, Math.max(1, x1 - x0), h)
        }
    }, [histogram, width, domain])

    // Pinch zoom (Chromium delivers a trackpad pinch as a ctrlKey wheel)
    // anchored at the cursor, and horizontal two-finger scroll as a pan.
    // Attached natively (passive: false) because React's synthetic wheel
    // cannot preventDefault the browser page-zoom.
    useEffect(() => {
        const el = boxRef.current
        if (!el) return
        const onWheel = (e: WheelEvent): void => {
            const cb = onDomainChangeRef.current
            if (!cb) return
            const d = domainRef.current
            const rect = el.getBoundingClientRect()
            const span = d.max - d.min
            if (!(span > 0) || rect.width <= 0) return
            if (e.ctrlKey) {
                e.preventDefault()
                const t = Math.min(
                    1, Math.max(0, (e.clientX - rect.left) / rect.width),
                )
                const anchor = d.min + t * span
                const factor = Math.exp(e.deltaY * PINCH_ZOOM_K)
                const next = {
                    min: anchor - (anchor - d.min) * factor,
                    max: anchor + (d.max - anchor) * factor,
                }
                if (next.max - next.min > 0) cb(next)
            } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                e.preventDefault()
                // max from min + span: wheel pans accumulate, and shifting
                // both ends independently would drift the span.
                const min = d.min + (e.deltaX / rect.width) * span
                cb({ min, max: min + span })
            }
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
    }, [])

    /**
     * Press on the strip: hand-drag pan (content follows the pointer), or --
     * with `onClickValue` -- a click when released without moving.
     */
    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.button !== 0 || disabled) return
            const canPan = !!onDomainChangeRef.current
            const canClick = !!onClickValueRef.current
            if (!canPan && !canClick) return
            const el = boxRef.current
            if (!el) return
            e.preventDefault()
            const rect = el.getBoundingClientRect()
            const startX = e.clientX
            const start = domainRef.current
            const span = start.max - start.min
            if (!(span > 0) || rect.width <= 0) return
            // Without click-to-value a press pans at once (no dead zone).
            let moved = !canClick
            if (moved) setPanning(true)
            const onMove = (ev: MouseEvent): void => {
                const dx = ev.clientX - startX
                if (!moved) {
                    if (Math.abs(dx) <= DRAG_THRESHOLD_PX) return
                    moved = true
                    if (canPan) setPanning(true)
                }
                if (!canPan) return
                const min = start.min + (-dx / rect.width) * span
                onDomainChangeRef.current?.({ min, max: min + span })
            }
            const onUp = (ev: MouseEvent): void => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                setPanning(false)
                if (moved) return
                const x = ev.clientX - rect.left
                onClickValueRef.current?.(xToValue(x, start.min, start.max, rect.width))
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
        },
        [disabled],
    )

    return (
        <div
            ref={boxRef}
            className={
                'mg-histo' +
                (onDomainChange ? ' is-pannable' : '') +
                (panning ? ' is-panning' : '') +
                (className ? ` ${className}` : '')
            }
            onMouseDown={handleMouseDown}
        >
            <canvas ref={canvasRef} className="mg-histo-canvas" />
            {children}
        </div>
    )
}
