/**
 * @file __test__/cameraInspectorLink.test.tsx
 * @description Pins how the Camera pane and the inspector keep one camera in
 * step (real InspectorProvider, real CameraPane):
 *
 *   - the Property button raises CameraShowProperties for the selected row;
 *   - while the inspector shows a camera, picking another row follows it, and
 *     while it shows anything else, the pane's selection is its own;
 *   - a rename through the inspector moves the pane's selection, and an inline
 *     rename in the pane keeps it even when the inspector shows a node.
 */

import React from 'react'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

void React

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))
vi.mock('@renderer/hooks/cuemol/useCueMolEventListener', () => ({
    useCueMolEventListener: () => undefined,
}))

const dispatch = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve(true)))
vi.mock('@renderer/hooks/cuemol/useCueMol', async () =>
    (await import('@renderer/__test__/helpers/paneEnv')).mockCueMolModule())
vi.mock('@renderer/state/workspace', async () =>
    (await import('@renderer/__test__/helpers/paneEnv')).mockWorkspaceModule())
vi.mock('@renderer/state/layout', () => ({
    useLayout: () => ({ inspectorOpen: true }),
    useLayoutDispatch: () => ({ setInspectorOpen: () => undefined }),
}))
vi.mock('@renderer/commands/CommandRegistry', () => ({ useCommands: () => ({ dispatch }) }))
vi.mock('@renderer/hooks/useClipboardScope', () => ({ useClipboardScope: () => undefined }))
vi.mock('@renderer/features/camera/useCameraCtxMenu', () => ({
    useCameraCtxMenu: () => vi.fn(() => Promise.resolve()),
}))

import { CameraPane } from '@renderer/features/camera/CameraPane'
import { InspectorProvider, useInspector, useInspectorActions } from '@renderer/state/inspector/InspectorProvider'
import type { InspectorActions, InspectorState } from '@renderer/state/inspector/InspectorProvider'
import { CmdId } from '@renderer/commands/ids'
import { mountTree, flushPromises } from '@renderer/__test__/helpers/testHarness'
import { withPaneEnv } from '@renderer/__test__/helpers/paneEnv'

const SCENE = 100
const CAMERAS = ['cam0', 'cam1', 'camX'].map((name, i) => ({ name, src: '', visSize: 0, uiOrder: i }))

let actions: InspectorActions
let state: InspectorState
const Probe: React.FC = () => {
    actions = useInspectorActions()
    state = useInspector()
    return null
}

function makeCm() {
    return {
        invokeService: vi.fn((name: string) =>
            Promise.resolve(name === 'listCameras' ? { ok: true, cameras: CAMERAS } : { ok: true, entries: [] }),
        ),
        addEventListener: vi.fn(() => Promise.resolve(1)),
        removeEventListener: vi.fn(() => Promise.resolve()),
    }
}

function row(c: HTMLElement, name: string): HTMLElement {
    return c.querySelector(`[data-camera-name="${name}"]`) as HTMLElement
}
const selectedName = (c: HTMLElement): string | null =>
    c.querySelector('.is-selected[data-camera-name]')?.getAttribute('data-camera-name') ?? null
const inspected = (): string | null => (state.target?.kind === 'camera' ? state.target.name : null)

function fire(el: Element, ev: Event): void {
    act(() => {
        el.dispatchEvent(ev)
    })
}
const click = (el: Element): void => fire(el, new MouseEvent('click', { bubbles: true }))

describe('Camera pane <-> inspector', () => {
    let view: { container: HTMLElement; unmount(): void }

    beforeEach(async () => {
        dispatch.mockClear()
        view = mountTree(
            withPaneEnv(
                makeCm(),
                SCENE,
                7,
                <InspectorProvider>
                    <Probe />
                    <CameraPane collapsed={false} />
                </InspectorProvider>,
            ),
        )
        await flushPromises()
    })
    afterEach(() => view.unmount())

    it('opens from Property and follows the row only while a camera is shown', async () => {
        const c = view.container
        click(row(c, 'cam0'))
        expect(inspected()).toBeNull()

        // The last toolbar button is Property.
        const btns = c.querySelectorAll('.sp-section-header-actions button')
        click(btns[btns.length - 1])
        expect(dispatch).toHaveBeenLastCalledWith(CmdId.CameraShowProperties, { name: 'cam0' })

        act(() => actions.showCamera(SCENE, 'cam0'))
        click(row(c, 'cam1'))
        expect(inspected()).toBe('cam1')

        act(() => actions.showNode({ kind: 'node', sceneId: SCENE, nodeId: 5, nodeType: 'object' }))
        await flushPromises()
        click(row(c, 'cam0'))
        expect(state.target?.kind).toBe('node')
        expect(selectedName(c)).toBe('cam0')
    })

    it('keeps the pane selection across an inspector rename and a pane rename', async () => {
        const c = view.container
        // Through the inspector (what CameraRename does on success).
        act(() => actions.showCamera(SCENE, 'cam0'))
        act(() => actions.renameCameraTarget(SCENE, 'cam0', 'camX'))
        expect(inspected()).toBe('camX')
        expect(selectedName(c)).toBe('camX')

        // Inline in the pane while the inspector shows a node.
        act(() => actions.showNode({ kind: 'node', sceneId: SCENE, nodeId: 5, nodeType: 'object' }))
        await flushPromises()
        click(row(c, 'cam1'))
        fire(c.querySelector('.camera-pane-body')!, new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
        const input = c.querySelector('[data-camera-name="cam1"] input') as HTMLInputElement
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'cam0')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        fire(input, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await flushPromises()
        expect(dispatch).toHaveBeenLastCalledWith(CmdId.CameraRename, { oldName: 'cam1', newName: 'cam0' })
        expect(selectedName(c)).toBe('cam0')
    })
})
