/**
 * Degrade-detection tests for `setupRenderer` (worker service).
 *
 * Pins the new direct-API contract introduced after we replaced the
 * `NewRendererCommand` property-setter pattern with `mol.createRenderer()`:
 *
 *   - `mol.createRenderer(type)` is the only renderer-creation call;
 *     `ctx.cmdMgr.getCmd('new_renderer')` MUST NOT be invoked (avoids
 *     the `cmd.target_object = mol` parent-linkage corruption that
 *     silently broke coloring undo)
 *   - rend.name + applyStyles + recenter-views happen in the same order
 *     as `NewRendererCommand::run()`
 *   - the existing selection / molPostProc gates still hold, and a renderer
 *     that cannot be created still leaves a new molecule post-processed
 *     (its default paint), unless the load removes it again
 *
 * The "does NOT call getCmd('new_renderer')" assertion is the regression
 * tripwire for re-introducing the buggy command path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RendererOptions } from '@renderer/dialogs/fopen-opt-dlgs/types'

vi.mock('@renderer/worker/server/services/helpers/makeSel', () => ({
    makeSel: vi.fn(() => ({ __sel: true })),
}))
vi.mock('@renderer/worker/server/services/helpers/molPostProc', () => ({
    molPostProc: vi.fn(),
}))
vi.mock('@renderer/worker/server/services/sceneTree/sceneOps', () => ({
    focusAllViewsOnNode: vi.fn(),
}))
vi.mock('@renderer/worker/server/services/helpers/getDefaultStyleName', () => ({
    getDefaultStyleName: vi.fn(() => 'DefaultStyle'),
}))

import { setupRenderer } from '@renderer/worker/server/services/rend/setupRenderer'
import { makeSel } from '@renderer/worker/server/services/helpers/makeSel'
import { molPostProc } from '@renderer/worker/server/services/helpers/molPostProc'
import { getDefaultStyleName } from '@renderer/worker/server/services/helpers/getDefaultStyleName'
import { focusAllViewsOnNode } from '@renderer/worker/server/services/sceneTree/sceneOps'
import { fakeObject, fakeRenderer, fakeScene, fakeView, makeWorkerCtx } from '@renderer/worker/testing'

/**
 * One object in one scene. Renderers the service creates through
 * `mol.createRenderer` / `createPresetRenderer` land in `mol.renderers`,
 * so a test reads the created renderer back from there.
 */
function makeFixture(opts: { className: string; viewIds?: number[]; hasGetCenter?: boolean }) {
    const log: string[] = []
    const scene = fakeScene({ uid: 100, views: (opts.viewIds ?? []).map((uid) => fakeView({ uid })), log })
    const mol = fakeObject({
        className: opts.className, scene, log,
        rendererDefaults: { hasCenter: opts.hasGetCenter !== false },
    })
    const { ctx, cmdMgr } = makeWorkerCtx({ scenes: [scene] })
    return { ctx, mol, scene, log, getCmd: cmdMgr.getCmd, rend: () => mol.renderers[0] }
}

const baseOpts: RendererOptions = {
    objectName: 'm',
    rendererType: 'simple',
    rendererName: 'simple1',
    selectionEnabled: false,
    selection: 'protein',
    centerView: false,
    mapCenterPolicy: 'auto' as const,
}

describe('setupRenderer — direct API (no NewRendererCommand)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('uses mol.createRenderer(type), never asks cmdMgr for new_renderer', () => {
        const { ctx, mol, getCmd } = makeFixture({ className: 'MolCoord' })
        setupRenderer(ctx, mol as unknown, baseOpts, true)
        expect(mol.createRenderer).toHaveBeenCalledWith('simple')
        expect(getCmd).not.toHaveBeenCalled()
    })

    it('returns null when createRenderer fails, still giving a new molecule its post-processing', () => {
        const { ctx, mol, log } = makeFixture({ className: 'MolCoord' })
        // An unregistered type: C++ RendererFactory::create throws.
        mol.createRenderer.mockImplementationOnce(() => {
            throw new Error('unknown renderer type')
        })
        expect(setupRenderer(ctx, mol as unknown, baseOpts, true)).toBeNull()
        // No renderer to name or style, but the molecule keeps its default
        // paint: a renderer added later must not draw it white.
        expect(log).toEqual([])
        expect(molPostProc).toHaveBeenCalledWith(ctx, mol, true, expect.any(Number))

        // A load that will remove the object again writes nothing (the paint
        // would leave colours in the scene's style set).
        vi.mocked(molPostProc).mockClear()
        mol.createRenderer.mockReturnValueOnce(null)
        expect(setupRenderer(ctx, mol as unknown, { ...baseOpts, requireRenderer: true }, true)).toBeNull()
        expect(molPostProc).not.toHaveBeenCalled()
    })

    it('sets renderer name, applies default style, then runs molPostProc (in that order)', () => {
        const { ctx, mol, log } = makeFixture({ className: 'MolCoord' })
        setupRenderer(ctx, mol as unknown, baseOpts, false)
        // createRenderer first, then name, then applyStyles. molPostProc runs after.
        expect(log).toEqual([
            'mol.createRenderer(simple)',
            'rend.name=simple1',
            'rend.applyStyles(DefaultStyle)',
        ])
        // newObj reaches molPostProc as given: false (a renderer added to an
        // existing molecule) must not reset mol.coloring, true (a new molecule)
        // must still give it the default paint coloring.
        expect(molPostProc).toHaveBeenCalledTimes(1)
        expect(vi.mocked(molPostProc).mock.calls[0][2]).toBe(false)
        setupRenderer(ctx, mol as unknown, baseOpts, true)
        expect(vi.mocked(molPostProc).mock.calls[1][2]).toBe(true)
    })

    // The default style of a map renderer depends on the map kind (the
    // CryoEM styles carry the EM level default), so the lookup must see it.
    it('passes the map kind of a DensityMap to the default-style lookup', () => {
        const { ctx, mol } = makeFixture({ className: 'DensityMap' })
        mol.map_type_resolved = 'em'
        setupRenderer(ctx, mol as unknown, { ...baseOpts, rendererType: 'isosurf', rendererName: 'iso1' }, true)
        expect(getDefaultStyleName).toHaveBeenCalledWith('isosurf', 'em')
    })

    // Center view frames the new renderer as the Focus button does (centre
    // and zoom), in every view, unrecorded -- and only once its selection is
    // set, so a renderer of one chain frames that chain, not the molecule.
    it('centerView=true fits every view to the renderer after its selection is set', () => {
        const { ctx, mol, rend } = makeFixture({ className: 'MolCoord', viewIds: [10, 11] })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, centerView: true, selectionEnabled: true, selection: 'chain A' }, true)
        const r = rend()
        expect(focusAllViewsOnNode).toHaveBeenCalledTimes(1)
        expect(vi.mocked(focusAllViewsOnNode).mock.calls[0].slice(2)).toEqual([r.uid, 'renderer'])
        expect(r.sets.sel).toHaveBeenCalled()
        expect(r.sets.sel.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(focusAllViewsOnNode).mock.invocationCallOrder[0])
    })

    it('centerView=false does not touch the views', () => {
        const { ctx, mol } = makeFixture({ className: 'MolCoord', viewIds: [10] })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, centerView: false }, true)
        expect(focusAllViewsOnNode).not.toHaveBeenCalled()
    })

    // MapRenderer::getCenter() is the map's DISPLAY center, at the origin on a
    // fresh renderer -- recentering there threw the view off the structure and
    // left the map drawing an empty box. What the view does for a volume
    // object is decided later, by applyMapCenterPolicy.
    it('never recenters on a volume object, even with centerView=true', () => {
        for (const className of ['DensityMap', 'ElePotMap']) {
            const { ctx, mol } = makeFixture({ className, viewIds: [10] })
            setupRenderer(ctx, mol as unknown, { ...baseOpts, centerView: true }, true)
            expect(focusAllViewsOnNode, className).not.toHaveBeenCalled()
        }
    })

    // --- Selection gate (preserved from the prior contract) ---

    it('selectionEnabled=false skips sel even when selection is non-default', () => {
        const { ctx, mol, rend } = makeFixture({ className: 'MolCoord' })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, selectionEnabled: false, selection: 'protein' }, true)
        expect(makeSel).not.toHaveBeenCalled()
        expect(rend().sets.sel).not.toHaveBeenCalled()
    })

    it('selectionEnabled=true with concrete selection assigns sel via makeSel', () => {
        const { ctx, mol, rend } = makeFixture({ className: 'MolCoord' })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, selectionEnabled: true, selection: 'protein' }, true)
        expect(makeSel).toHaveBeenCalledTimes(1)
        expect(rend().sets.sel).toHaveBeenCalledTimes(1)
        expect(rend().sets.sel).toHaveBeenCalledWith({ __sel: true })
    })

    it('selectionEnabled=true with selection="*" still skips sel (full-molecule shorthand)', () => {
        const { ctx, mol, rend } = makeFixture({ className: 'MolCoord' })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, selectionEnabled: true, selection: '*' }, true)
        expect(makeSel).not.toHaveBeenCalled()
        expect(rend().sets.sel).not.toHaveBeenCalled()
    })

    it('NON_MOL class skips sel + molPostProc even when selectionEnabled=true', () => {
        const { ctx, mol, rend } = makeFixture({ className: 'DensityMap' })
        setupRenderer(ctx, mol as unknown, { ...baseOpts, selectionEnabled: true, selection: 'protein' }, true)
        expect(makeSel).not.toHaveBeenCalled()
        expect(rend().sets.sel).not.toHaveBeenCalled()
        expect(molPostProc).not.toHaveBeenCalled()
    })
})

describe('setupRenderer — preset renderer group (presetName set)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    const presetOpts: RendererOptions = {
        ...baseOpts,
        presetName: 'Default1RendPreset',
        rendererName: 'default1_1',
    }

    it('creates via createPresetRenderer(preset, name, name); no createRenderer / name / applyStyles / getCmd', () => {
        const f = makeFixture({ className: 'MolCoord' })
        const result = setupRenderer(f.ctx, f.mol as unknown, presetOpts, true)
        expect(f.mol.createPresetRenderer).toHaveBeenCalledWith(
            'Default1RendPreset', 'default1_1', 'default1_1',
        )
        expect(f.mol.createRenderer).not.toHaveBeenCalled()
        // C++ setName(grp_name) already named the group; children carry
        // their styles from the preset definition.
        expect(f.rend().sets.name).not.toHaveBeenCalled()
        expect(f.rend().applyStyles).not.toHaveBeenCalled()
        expect(f.getCmd).not.toHaveBeenCalled()
        expect(result).toBe(f.rend())
    })

    it('runs molPostProc for a mol class but never assigns sel (RendGroup has none)', () => {
        const f = makeFixture({ className: 'MolCoord' })
        setupRenderer(f.ctx, f.mol as unknown, {
            ...presetOpts, selectionEnabled: true, selection: 'protein',
        }, false)
        // A preset added to an existing molecule keeps mol.coloring: the preset
        // branch has its own molPostProc call, so it is pinned separately.
        expect(molPostProc).toHaveBeenCalledTimes(1)
        expect(vi.mocked(molPostProc).mock.calls[0][2]).toBe(false)
        expect(makeSel).not.toHaveBeenCalled()
        expect(f.rend().sets.sel).not.toHaveBeenCalled()
    })

    it('skips molPostProc for a NON_MOL class', () => {
        const f = makeFixture({ className: 'DensityMap' })
        setupRenderer(f.ctx, f.mol as unknown, presetOpts, true)
        expect(molPostProc).not.toHaveBeenCalled()
    })

    it('centerView=true fits the views to the preset group', () => {
        const f = makeFixture({ className: 'MolCoord', viewIds: [10] })
        setupRenderer(f.ctx, f.mol as unknown, { ...presetOpts, centerView: true }, true)
        expect(focusAllViewsOnNode).toHaveBeenCalledWith(f.ctx, expect.anything(), f.rend().uid, 'renderer')
    })

    it('returns null when createPresetRenderer throws, and the new molecule still gets its default paint', () => {
        const f = makeFixture({ className: 'MolCoord' })
        f.mol.createPresetRenderer.mockImplementationOnce(() => {
            throw new Error('Unknown renderer preset')
        })
        const result = setupRenderer(f.ctx, f.mol as unknown, presetOpts, true)
        expect(result).toBeNull()
        expect(molPostProc).toHaveBeenCalledWith(f.ctx, f.mol, true, expect.any(Number))
    })
})

/**
 * A disorder overlay draws along a main-chain renderer named by its `target`
 * property, so one created with no target draws nothing. UXP seeds it in
 * `molPostProc` ("setup disorder renderer"); these pin that tritium does the
 * same, and only for `disorder`.
 */
describe('setupRenderer - disorder target seeding', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    const disoOpts: RendererOptions = { ...baseOpts, rendererType: 'disorder', rendererName: 'diso1' }

    it('points a new disorder renderer at the first main-chain sibling', () => {
        const f = makeFixture({ className: 'MolCoord' })
        f.mol.attachRenderer(fakeRenderer({ type: 'simple', name: 'simple1' }))
        f.mol.attachRenderer(fakeRenderer({ type: 'ribbon', name: 'ribbon1' }))
        f.mol.attachRenderer(fakeRenderer({ type: 'cartoon', name: 'cartoon1' }))

        setupRenderer(f.ctx, f.mol as unknown, disoOpts, true)

        // 'simple' is not a main-chain type; 'ribbon' comes first among those.
        const diso = f.mol.renderers.find((r) => r.type_name === 'disorder')
        expect((diso as unknown as { target?: string }).target).toBe('ribbon1')
    })

    it('leaves the target unset when the molecule has no main-chain renderer', () => {
        const f = makeFixture({ className: 'MolCoord' })
        f.mol.attachRenderer(fakeRenderer({ type: 'simple', name: 'simple1' }))

        setupRenderer(f.ctx, f.mol as unknown, disoOpts, true)

        const diso = f.mol.renderers.find((r) => r.type_name === 'disorder')
        expect((diso as unknown as { target?: string }).target).toBeUndefined()
    })

    it('does not touch the target of a renderer of any other type', () => {
        const f = makeFixture({ className: 'MolCoord' })
        f.mol.attachRenderer(fakeRenderer({ type: 'tube', name: 'tube1' }))

        setupRenderer(f.ctx, f.mol as unknown, baseOpts, true)

        const rend = f.mol.renderers.find((r) => r.type_name === 'simple')
        expect((rend as unknown as { target?: string }).target).toBeUndefined()
    })
})
