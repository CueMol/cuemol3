/**
 * Pin the two contracts of the density-map Level histogram:
 *
 *   - LevelHistogramField undo granularity: a marker drag previews per frame
 *     and commits once with the pre-drag value; Esc aborts with no commit; a
 *     click on empty strip space commits the value under the pointer.
 *   - getMapHistogram wire shape: the map renderer's parent map is rebinned
 *     and returned as { histo, nmax, globalNmax }.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'

void React

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))

import { LevelHistogramField, type GradientHistogram } from '@renderer/h3-kit/gradient'
import { FieldGrid } from '@renderer/h3-kit/form'
import { getMapHistogram } from '@renderer/worker/server/services/map/histogram'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import { mountTree } from '@renderer/__test__/helpers/testHarness'

// jsdom has no ResizeObserver; the strip observes its box.
class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

const HISTOGRAM: GradientHistogram = {
    bins: [1, 2, 3, 4],
    nmax: 4,
    globalNmax: null,
    domain: { min: 0, max: 10 },
}

/** 200 px wide strip over [0, 10]: 20 px per unit. */
function pinRect(el: Element): void {
    ;(el as HTMLElement).getBoundingClientRect = () =>
        ({
            left: 0, top: 0, right: 200, bottom: 48,
            width: 200, height: 48, x: 0, y: 0,
            toJSON: () => ({}),
        }) as DOMRect
}

function mouse(type: string, clientX: number): MouseEvent {
    return new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 10 })
}

function setup() {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const onAbort = vi.fn()
    const tree = mountTree(
        <FieldGrid>
            <LevelHistogramField
                label="Level"
                valueField={<span />}
                value={5}
                histogram={HISTOGRAM}
                domain={{ min: 0, max: 10 }}
                onPreview={onPreview}
                onCommit={onCommit}
                onAbort={onAbort}
                onDomainChange={() => {}}
                onFit={() => {}}
            />
        </FieldGrid>,
    )
    pinRect(tree.container.querySelector('.mg-level-strip')!)
    pinRect(tree.container.querySelector('.mg-histo')!)
    const marker = tree.container.querySelector('.mg-level-marker') as HTMLElement
    const strip = tree.container.querySelector('.mg-histo') as HTMLElement
    return { ...tree, marker, strip, onPreview, onCommit, onAbort }
}

describe('LevelHistogramField', () => {
    beforeEach(() => {
        // A frame callback runs after the current task, as in a browser.
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            queueMicrotask(() => cb(0))
            return 1
        })
        vi.stubGlobal('cancelAnimationFrame', () => {})
    })
    afterEach(() => { vi.unstubAllGlobals() })

    it('a marker drag previews, then commits once with the pre-drag value', async () => {
        const t = setup()
        await act(async () => {
            t.marker.dispatchEvent(mouse('mousedown', 100))
            document.dispatchEvent(mouse('mousemove', 120))
            document.dispatchEvent(mouse('mousemove', 140))
            await Promise.resolve()
            document.dispatchEvent(mouse('mouseup', 140))
        })
        expect(t.onPreview).toHaveBeenCalled()
        expect(t.onPreview.mock.calls.at(-1)![0]).toBeCloseTo(7)
        expect(t.onCommit).toHaveBeenCalledTimes(1)
        expect(t.onCommit.mock.calls[0][0]).toBeCloseTo(7)
        expect(t.onCommit.mock.calls[0][1]).toBe(5)
        expect(t.onAbort).not.toHaveBeenCalled()
        t.unmount()
    })

    it('Esc during a marker drag aborts with the pre-drag value and commits nothing', async () => {
        const t = setup()
        await act(async () => {
            t.marker.dispatchEvent(mouse('mousedown', 100))
            document.dispatchEvent(mouse('mousemove', 140))
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
            document.dispatchEvent(mouse('mouseup', 140))
        })
        expect(t.onAbort).toHaveBeenCalledWith(5)
        expect(t.onCommit).not.toHaveBeenCalled()
        t.unmount()
    })

    it('a click on empty strip space commits the value under the pointer', async () => {
        const t = setup()
        await act(async () => {
            t.strip.dispatchEvent(mouse('mousedown', 40))
            document.dispatchEvent(mouse('mouseup', 40))
        })
        expect(t.onPreview).not.toHaveBeenCalled()
        expect(t.onCommit).toHaveBeenCalledTimes(1)
        expect(t.onCommit.mock.calls[0][0]).toBeCloseTo(2)
        expect(t.onCommit.mock.calls[0][1]).toBe(5)
        t.unmount()
    })
})

describe('getMapHistogram', () => {
    it("rebins the renderer's parent map into { histo, nmax, globalNmax }", () => {
        const getHistogramJSON = vi.fn((min: number, max: number, nbins: number) =>
            JSON.stringify({ histo: Array.from({ length: nbins }, (_, i) => i + 1), nmax: nbins, min, max }),
        )
        const map = { den_min: 0, den_max: 4, den_mean: 1, den_sigma: 1, getHistogramJSON }
        const rend = { getClientObj: () => map }
        const scene = { getRenderer: (id: number) => (id === 7 ? rend : null) }
        const ctx = { sceMgr: { getScene: (id: number) => (id === 1 ? scene : null) } } as unknown as WorkerContext

        const res = getMapHistogram(ctx, { sceneId: 1, rendId: 7, min: 1, max: 2, nbins: 2 })

        expect(getHistogramJSON).toHaveBeenCalledWith(1, 2, 2)
        // Full range [0, 4] on the same 0.5-wide grid: 8 bins, max 8.
        expect(res).toEqual({ ok: true, histo: [1, 2], nmax: 2, globalNmax: 8 })
        expect(getMapHistogram(ctx, { sceneId: 1, rendId: 99, min: 1, max: 2, nbins: 2 }).ok).toBe(false)
    })
})
