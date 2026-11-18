/**
 * @file h3-kit/gradient/LevelHistogramField.tsx
 * @description A threshold picked on a histogram (ChimeraX volume viewer
 * style). Rows of a `FieldGrid`, so it must be placed inside one:
 *   - a labelled row with the caller's value input (`valueField`, typed
 *     entry in whatever unit the caller shows) and the view-range buttons:
 *     zoom out / zoom in / Fit,
 *   - the value distribution as a log-scaled strip with the current value as
 *     a vertical marker on it (full width),
 *   - the view range's min / max with an optional caption between them
 *     (`hint`, e.g. the value in the strip's own unit) (full width).
 *
 * Zoom keeps the value where it is on the strip (anchored at the value when
 * it is in view, else at the centre), so zooming in closes in on the marker.
 *
 * Controlled + CueMol-independent: the parent owns the value and every write.
 *   - drag the marker -> onPreview per animation frame (coalesced), then
 *     onCommit(value, original) on release (onAbort(original) when released
 *     where it started); Shift moves it at a tenth of the pointer speed; Esc
 *     during the drag -> onAbort(original),
 *   - click empty strip space (press and release without moving) ->
 *     onCommit(value, original) with the value under the pointer,
 *   - drag empty strip space / pinch / horizontal scroll, or the zoom
 *     buttons -> onDomainChange (view range only; the value does not move),
 *   - the Fit button -> onFit.
 *
 * While the marker is dragged it shows the dragged value, not `value`, and
 * the caller should freeze `domain` (the axis moving with the marker would
 * make it appear to stand still). A value outside the domain pins the marker
 * at that edge, drawn as out of range.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { GradientHistogram, ValueDomain } from './gradientGeometry'
import { valueToX, xToValue } from './gradientGeometry'
import { HistogramStrip } from './HistogramStrip'
import { FormButton } from '../form/ButtonRow'
import { FieldGridRow, FieldGridSpan } from '../form/FieldGrid'

void React // classic JSX runtime (vitest)

/** Pointer-to-value scale while Shift is held (ChimeraX: 0.1). */
const FINE_DRAG_FACTOR = 0.1

/** View-range factor per zoom button press (same as the gradient deck). */
const ZOOM_STEP = 1.5

interface LevelHistogramFieldProps {
    /** Row label (grid label column). */
    label: string
    /** Typed-entry control for the value, in the caller's display unit. */
    valueField: React.ReactNode
    /** Caption between the min / max labels (e.g. the value in another unit). */
    hint?: string
    /** Committed value, in the histogram's value units. */
    value: number
    /** Strip data; null draws an empty strip (still pickable). */
    histogram: GradientHistogram | null
    /** View range of the strip. */
    domain: ValueDomain
    disabled?: boolean
    /** A marker drag started (the caller freezes its domain). */
    onDragStart?: () => void
    /** Per-frame value during a marker drag. */
    onPreview: (value: number) => void
    /** Final value; `original` is the value before the gesture (for one undo step). */
    onCommit: (value: number, original: number) => void
    /** Esc during a marker drag; restore `original`. */
    onAbort: (original: number) => void
    /** View range changes: strip gestures and the zoom buttons. */
    onDomainChange: (domain: ValueDomain) => void
    /** Reports the strip's CSS width (mount and resize) for bin sizing. */
    onWidthChange?: (widthPx: number) => void
    /** The Fit button: reset the view range. */
    onFit: () => void
    /** Number format for the min / max labels. */
    format?: (v: number) => string
}

const defaultFormat = (v: number): string =>
    Number.isFinite(v) ? Number(v.toPrecision(3)).toString() : '?'

/**
 * The level-on-histogram field. See the file header for the interaction
 * contract.
 */
export const LevelHistogramField: React.FC<LevelHistogramFieldProps> = ({
    label,
    valueField,
    hint,
    value,
    histogram,
    domain,
    disabled,
    onDragStart,
    onPreview,
    onCommit,
    onAbort,
    onDomainChange,
    onWidthChange,
    onFit,
    format = defaultFormat,
}) => {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const stripBoxRef = useRef<HTMLDivElement | null>(null)
    /** Value shown while the marker is dragged; null when idle. */
    const [dragValue, setDragValue] = useState<number | null>(null)

    const onWidthChangeRef = useRef(onWidthChange)
    onWidthChangeRef.current = onWidthChange

    useEffect(() => {
        const el = rootRef.current
        if (!el || !onWidthChangeRef.current) return
        const report = () => onWidthChangeRef.current?.(el.clientWidth)
        const ro = new ResizeObserver(report)
        ro.observe(el)
        report()
        return () => ro.disconnect()
    }, [])

    const handleMarkerMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.button !== 0 || disabled) return
            // The strip below would otherwise start a pan / click.
            e.preventDefault()
            e.stopPropagation()
            const box = stripBoxRef.current
            if (!box) return
            const width = box.getBoundingClientRect().width
            if (!(width > 0)) return
            const original = value
            const { min, max } = domain
            let x = valueToX(original, min, max, width)
            let lastClientX = e.clientX
            let current = original
            let started = false
            let frame: number | null = null

            const flush = (): void => {
                frame = null
                onPreview(current)
            }
            const onMove = (ev: MouseEvent): void => {
                const dx = ev.clientX - lastClientX
                lastClientX = ev.clientX
                if (dx === 0) return
                if (!started) {
                    started = true
                    onDragStart?.()
                }
                x = Math.min(width, Math.max(0, x + dx * (ev.shiftKey ? FINE_DRAG_FACTOR : 1)))
                current = xToValue(x, min, max, width)
                setDragValue(current)
                // One preview per animation frame: each one redraws the contour.
                if (frame === null) frame = requestAnimationFrame(flush)
            }
            const cleanup = (): void => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                document.removeEventListener('keydown', onKeyDown)
                if (frame !== null) cancelAnimationFrame(frame)
                frame = null
                setDragValue(null)
            }
            const onUp = (): void => {
                cleanup()
                if (!started) return
                // Back where it started: nothing to record, but the previews
                // still have to be undone (and the caller's drag ended).
                if (current === original) onAbort(original)
                else onCommit(current, original)
            }
            const onKeyDown = (ev: KeyboardEvent): void => {
                if (ev.key !== 'Escape') return
                cleanup()
                if (started) onAbort(original)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
            document.addEventListener('keydown', onKeyDown)
        },
        [disabled, value, domain, onDragStart, onPreview, onCommit, onAbort],
    )

    /** Zoom by `factor`, anchored at the value when it is in view. */
    const handleZoom = useCallback(
        (factor: number) => {
            const { min, max } = domain
            const inView = Number.isFinite(value) && value >= min && value <= max
            const a = inView ? value : (min + max) / 2
            const next = { min: a - (a - min) * factor, max: a + (max - a) * factor }
            if (next.max > next.min) onDomainChange(next)
        },
        [domain, value, onDomainChange],
    )

    const handleClickValue = useCallback(
        (v: number) => {
            if (disabled || v === value) return
            onCommit(v, value)
        },
        [disabled, value, onCommit],
    )

    const shown = dragValue ?? value
    const span = domain.max - domain.min
    const t = span > 0 && Number.isFinite(shown) ? (shown - domain.min) / span : 0.5
    const outside = t < 0 || t > 1
    const pct = Math.min(100, Math.max(0, t * 100))
    const strip: GradientHistogram = histogram ?? {
        bins: [], nmax: 0, globalNmax: null, domain,
    }

    return (
        <>
            <FieldGridRow label={label}>
                <div className="mg-level-head">
                    {valueField}
                    <div className="mg-toolbar-spacer" />
                    <FormButton
                        text="-"
                        aria-label="Zoom out"
                        title="Widen the view range"
                        onClick={() => handleZoom(ZOOM_STEP)}
                        disabled={disabled}
                    />
                    <FormButton
                        text="+"
                        aria-label="Zoom in"
                        title="Narrow the view range"
                        onClick={() => handleZoom(1 / ZOOM_STEP)}
                        disabled={disabled}
                    />
                    <FormButton
                        text="Fit"
                        aria-label="Fit view range"
                        title="Back to the initial view range"
                        onClick={onFit}
                        disabled={disabled}
                    />
                </div>
            </FieldGridRow>
            <FieldGridSpan>
                <div
                    ref={rootRef}
                    className={`mg-level${disabled ? ' is-disabled' : ''}`}
                >
                    <div ref={stripBoxRef} className="mg-level-strip">
                        <HistogramStrip
                            histogram={strip}
                            domain={domain}
                            disabled={disabled}
                            onDomainChange={onDomainChange}
                            onClickValue={handleClickValue}
                        >
                            <div
                                className={
                                    'mg-level-marker' +
                                    (dragValue !== null ? ' is-dragging' : '') +
                                    (outside ? ' is-outside' : '')
                                }
                                style={{ left: `${pct}%` }}
                                onMouseDown={handleMarkerMouseDown}
                                role="slider"
                                aria-label={label}
                                aria-valuenow={shown}
                                aria-valuemin={domain.min}
                                aria-valuemax={domain.max}
                            >
                                <div className="mg-level-marker-line" />
                            </div>
                        </HistogramStrip>
                    </div>
                    <div className="mg-minmax-row type-caption">
                        <span>{format(domain.min)}</span>
                        {hint ? <span className="mg-level-hint">{hint}</span> : null}
                        <span>{format(domain.max)}</span>
                    </div>
                </div>
            </FieldGridSpan>
        </>
    )
}
