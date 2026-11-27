/**
 * @file __test__/MolStructPane.test.tsx
 * @description How many residue rows an expanded chain draws.
 *
 * Pinned: a chain of many residues (an MD system's waters) shows them
 * RESIDUE_PAGE at a time -- drawing them all at once blocked the main thread
 * -- and adds the next page when its "Loading more..." row scrolls into view.
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'

void React

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))
vi.mock('@renderer/hooks/cuemol/useCueMolEventListener', () => ({
    useCueMolEventListener: () => undefined,
}))
vi.mock('@renderer/hooks/cuemol/useCueMol', async () => (await import('@renderer/__test__/helpers/paneEnv')).mockCueMolModule())
vi.mock('@renderer/state/workspace', async () => (await import('@renderer/__test__/helpers/paneEnv')).mockWorkspaceModule())
vi.mock('@renderer/state/inspector', async () => (await import('@renderer/__test__/helpers/paneEnv')).mockInspectorModule())

import { MolStructPane, RESIDUE_PAGE } from '@renderer/features/selection/MolStructPane'
import { mountTree, flushPromises } from '@renderer/__test__/helpers/testHarness'
import { withPaneEnv } from '@renderer/__test__/helpers/paneEnv'

const NRES = 1200

/** The IntersectionObservers the pane made, to report a row as visible. */
const observers: { cb: IntersectionObserverCallback; els: Element[] }[] = []
class FakeObserver {
    private readonly rec: { cb: IntersectionObserverCallback; els: Element[] }
    constructor(cb: IntersectionObserverCallback) {
        this.rec = { cb, els: [] }
        observers.push(this.rec)
    }
    observe(el: Element): void { this.rec.els.push(el) }
    disconnect(): void { this.rec.els.length = 0 }
}

const cm = {
    invokeService: vi.fn((name: string) => {
        if (name === 'listSceneObjects') return Promise.resolve({ objects: [{ uid: 5, name: 'md', className: 'MolCoord' }] })
        if (name === 'getMolChains') return Promise.resolve({ ok: true, chains: [{ name: 'W' }] })
        if (name === 'getMolResidues') {
            return Promise.resolve({
                ok: true,
                residues: Array.from({ length: NRES }, (_, i) => ({ index: String(i + 1), name: 'HOH', single: '', sel: false })),
            })
        }
        return Promise.resolve(null)
    }),
}

/** The residue rows drawn ("<index> HOH"). */
const residueRows = (c: HTMLElement) =>
    [...c.querySelectorAll('.bp5-tree-node-label')].filter((l) => / HOH$/.test(l.textContent ?? '')).length

afterEach(() => {
    vi.unstubAllGlobals()
    observers.length = 0
})

describe('MolStructPane residue pages', () => {
    it('draws a long chain a page at a time, adding the next when its end scrolls into view', async () => {
        vi.stubGlobal('IntersectionObserver', FakeObserver)
        const { container, unmount } = mountTree(withPaneEnv(cm as never, 1, undefined, <MolStructPane />))
        await flushPromises()
        await flushPromises()

        const caret = container.querySelector('.h3-tree-caret') as HTMLElement
        await act(async () => { caret.click() })
        await flushPromises()

        expect(residueRows(container)).toBe(RESIDUE_PAGE)
        expect(container.textContent).toContain(`Loading more... (${NRES - RESIDUE_PAGE} left)`)

        // The "Loading more..." row comes into view: the next page is added.
        const last = observers[observers.length - 1]
        await act(async () => {
            last.cb(last.els.map((target) => ({ target, isIntersecting: true })) as unknown as IntersectionObserverEntry[], {} as IntersectionObserver)
        })
        expect(residueRows(container)).toBe(2 * RESIDUE_PAGE)
        unmount()
    })
})
