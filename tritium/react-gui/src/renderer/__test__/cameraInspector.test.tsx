/**
 * @file __test__/cameraInspector.test.tsx
 * @description Pins the Visibility section's write contract in
 * `CameraInspector`:
 *
 *   - Capture includes every row with the scene's current show / hide state
 *     (`currentVisible`), not the stored one;
 *   - each write rebuilds the whole set, so the section stays disabled from the
 *     write until the refetched rows land (a second write from stale rows would
 *     undo the first).
 */

import React from 'react'
import { act } from 'react'
import { describe, it, expect, vi } from 'vitest'

void React

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))
vi.mock('@renderer/hooks/cuemol/useCueMolEventListener', () => ({
    useCueMolEventListener: () => undefined,
}))
vi.mock('@renderer/commands/CommandRegistry', () => ({
    useCommands: () => ({ dispatch: vi.fn(() => Promise.resolve(true)) }),
}))

import { CameraInspector } from '@renderer/features/inspector/CameraInspector'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import { mountTree, flushPromises } from '@renderer/__test__/helpers/testHarness'

const DETAIL = {
    name: 'cam1', src: '', isCurrent: false, visSize: 1,
    center: [0, 0, 0], rotation: [0, 0, 0, 1], zoom: 20, distance: 200, slab: 20,
    perspective: false, centerMark: 'crosshair',
}
// 1CRN stored as hidden but currently shown; rend1 not stored, currently hidden.
const ENTRIES = [
    { tgtId: 11, tgtName: '1CRN', isObj: true, included: true, visible: false, currentVisible: true, depth: 0 },
    { tgtId: 21, tgtName: 'rend1', isObj: false, included: false, visible: false, currentVisible: false, depth: 1 },
]

describe('CameraInspector -- Visibility writes', () => {
    it('captures current visibility and stays disabled until the refetch lands', async () => {
        let releaseVis: (() => void) | null = null
        let visCalls = 0
        const invokeService = vi.fn((name: string) => {
            if (name === 'getCameraDetail') return Promise.resolve({ ok: true, detail: DETAIL })
            if (name === 'getCameraVisFlags') {
                visCalls += 1
                const res = { ok: true, entries: ENTRIES }
                // Hold the refetch after the first write.
                if (visCalls === 1) return Promise.resolve(res)
                return new Promise((r) => {
                    releaseVis = () => r(res)
                })
            }
            return Promise.resolve({ ok: true })
        })
        const cm = { invokeService } as unknown as AsyncCueMol
        const view = mountTree(
            <CameraInspector
                cm={cm}
                sceneId={100}
                name="cam1"
                focusRequest={null}
                onGone={() => undefined}
                onHeaderChange={() => undefined}
            />,
        )
        await flushPromises()

        const capture = Array.from(view.container.querySelectorAll('button')).find(
            (b) => b.textContent === 'Capture',
        )!
        act(() => {
            capture.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        await flushPromises()

        expect(invokeService).toHaveBeenCalledWith('setCameraVisFlags', {
            sceneId: 100,
            cameraName: 'cam1',
            entries: [
                expect.objectContaining({ tgtId: 11, included: true, visible: true }),
                expect.objectContaining({ tgtId: 21, included: true, visible: false }),
            ],
        })
        const checkboxes = () => Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        expect(checkboxes().every((cb) => cb.disabled)).toBe(true)

        await act(async () => {
            releaseVis!()
        })
        await flushPromises()
        expect(checkboxes().some((cb) => cb.disabled)).toBe(false)
        view.unmount()
    })
})
