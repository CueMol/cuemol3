/**
 * @file features/density/DensityMapPane.tsx
 * @description Side-panel surface that ports UXP `panel.densitymap`
 * (`uxp_gui/cuemol2/base/content/densitymap-panel.{xul,js}`).
 *
 * Contents:
 *   - Renderer dropdown listing every map renderer in the active scene
 *     (UXP filter: contour | isosurf | gpu_mapmesh | gpu_mapvol),
 *     labelled `<objName>/<rendName>`.
 *   - Dropdown menu (toolbar button) with a native-unit vs "Use absolute
 *     contour level" radio pair -- toggles `use_abslevel`. The native unit
 *     is sigma on a crystallographic map and the top percent of grid points
 *     on a cryo-EM map (`levelUnit`).
 *   - Redraw button (`redrawMapCenter`) and Cell button (reuses
 *     `showUnitCellRenderer` from the symmetry panel).
 *   - Solid color swatch + a "Solid color" item in the dropdown menu.
 *   - Transparency / Extent sliders and the Level entry. The Level entry
 *     writes `siglevel` in the native unit, or `level` in absolute mode (C++
 *     converts through the map kind), instead of UXP's inline
 *     sigma-to-absolute scaling.
 *   - The Level row is a typed entry (native unit, or absolute in absolute
 *     mode) above the map's density histogram, which shows the level as a
 *     draggable marker (ChimeraX volume viewer style; not in UXP). The
 *     marker always writes `level` (absolute) and previews into the renderer
 *     while dragged; the typed entry and its caption follow through the
 *     refetched state -- C++ owns the conversion between the absolute level
 *     and the native unit (sigma, or the top percent of grid points, which
 *     depends on the map's distribution).
 *
 * @remarks Coloring here is deliberately the *simple* half only: the solid
 * color. Everything richer -- switching to multi-gradient, editing the
 * gradient stops, the MOLFANC / potential schemes an isosurf map renderer
 * supports -- lives in the Coloring panel (`ColorPane`), so the two panels do
 * not offer overlapping editors for the same property. Deviation from UXP
 * `densitymap-panel`, which carried its own Solid / Multi-gradient radio pair
 * and opened the modal gradient editor from here.
 *
 * Consequences for the widgets below: the swatch is disabled whenever
 * `colormode !== "solid"` (it would write a color the renderer does not draw),
 * while the "Solid color" menu item stays enabled so this panel can always
 * bring a map back to solid without a detour through the Coloring panel.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Button,
    HTMLSelect,
    Menu,
    MenuDivider,
    MenuItem,
    Popover,
} from '@blueprintjs/core'
import { AppIcon } from '@renderer/h3-kit/primitives'
import { PaneSectionHeader } from '@renderer/shell/PaneSectionHeader'
import { DragRow, type MapPropWriteOpts } from '@renderer/features/density/densityMap/DragRow'
import { useDensityMapPanel } from './useDensityMapPanel'
import { levelControlFor } from './levelControl'
import { FieldGrid, NumericField, decimalsOf } from '@renderer/h3-kit/form'
import { LevelHistogramField } from '@renderer/h3-kit/gradient'
import { useLevelHistogram } from './useLevelHistogram'
import type {
    MapRendererEntry,
    MapRendererPropName,
} from '@renderer/worker/server/services/map/map.service'
import {
    SEM_OBJECT,
    SEM_RENDERER,
    SEM_SCENE,
    SEM_ANY,
} from '@renderer/event'
import { useCueMolEventListener } from '@renderer/hooks/cuemol/useCueMolEventListener'
import { CueColorField, ColorPickerProvider } from '@renderer/h3-kit/colorpicker'
import { fireService } from '@renderer/utils/fireService'
import { useCueMol } from '@renderer/hooks/cuemol/useCueMol'
import { useActiveScene } from '@renderer/state/workspace'

/**
 * Empty icon-column spacer for the unchecked radio rows of the level-mode
 * menu, so checked and unchecked labels align (the check icon is 16px).
 */
const CHECK_SPACER = <span style={{ display: 'inline-block', width: 16 }} aria-hidden />

/** Stored-value write options threaded to `setMapRendererProp`. */interface DensityMapPaneProps {
    collapsed?: boolean
    onToggleCollapse?: () => void
}

export const DensityMapPane: React.FC<DensityMapPaneProps> = ({ collapsed, onToggleCollapse }) => {
    const { cm } = useCueMol()
    const { activeSceneId, activeMolViewId } = useActiveScene()

    // --- Renderer enumeration ---
    const [items, setItems] = useState<MapRendererEntry[]>([])
    const [selectedRendId, setSelectedRendId] = useState<number | undefined>(undefined)
    const sceneIdRef = useRef(activeSceneId)
    sceneIdRef.current = activeSceneId
    const listToken = useRef(0)

    const fetchList = useCallback(() => {
        const sid = sceneIdRef.current
        if (!cm || sid === undefined) {
            setItems([])
            return
        }
        const token = ++listToken.current
        cm.invokeService('listMapRenderers', { sceneId: sid })
            .then((res) => {
                if (token !== listToken.current) return
                setItems(res?.items ?? [])
            })
            .catch((err: unknown) => {
                if (token !== listToken.current) return
                console.warn('listMapRenderers failed:', err)
                setItems([])
            })
    }, [cm])

    useEffect(() => { fetchList() }, [cm, activeSceneId, fetchList])

    useCueMolEventListener({
        cm,
        enabled: activeSceneId !== undefined,
        category: '',
        srcMask: SEM_OBJECT | SEM_RENDERER,
        evtMask: SEM_ANY,
        scopeId: activeSceneId ?? -1,
        handler: fetchList,
        debounceMs: 30,
    })
    useCueMolEventListener({
        cm,
        enabled: activeSceneId !== undefined,
        category: '',
        srcMask: SEM_SCENE,
        evtMask: SEM_ANY,
        scopeId: activeSceneId ?? -1,
        handler: fetchList,
        debounceMs: 30,
    })

    // Auto-default the selection when the list churns.
    useEffect(() => {
        const valid =
            selectedRendId !== undefined &&
            items.some((it) => it.rendId === selectedRendId)
        if (valid) return
        const next = items.length > 0 ? items[0].rendId : undefined
        if (next !== selectedRendId) setSelectedRendId(next)
        // Only react to items churn; selectedRendId / setter is stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items])

    const selectedEntry = useMemo(
        () => items.find((it) => it.rendId === selectedRendId),
        [items, selectedRendId],
    )

    // --- Renderer state (sliders, color, mode) ---
    const { state } = useDensityMapPanel({
        cm,
        sceneId: activeSceneId,
        rendId: selectedRendId,
    })

    // --- Mutations ---
    const setProp = useCallback(
        (
            propName: MapRendererPropName,
            value: number | boolean | string,
            opts?: MapPropWriteOpts,
        ) => {
            if (!cm || activeSceneId === undefined || selectedRendId === undefined) return
            fireService(cm, 'setMapRendererProp', {
                sceneId: activeSceneId,
                rendId: selectedRendId,
                propName,
                value,
                mode: opts?.mode,
                originalValue: opts?.originalValue,
                originalWasDefault: opts?.originalWasDefault,
            })
        },
        [cm, activeSceneId, selectedRendId],
    )

    const onRedraw = useCallback(() => {
        if (!cm
            || activeSceneId === undefined
            || activeMolViewId === undefined
            || selectedRendId === undefined) return
        fireService(cm, 'redrawMapCenter', {
            sceneId: activeSceneId,
            rendId: selectedRendId,
            viewId: activeMolViewId,
        })
    }, [cm, activeSceneId, activeMolViewId, selectedRendId])

    const onShowCell = useCallback(() => {
        if (!cm || activeSceneId === undefined || !selectedEntry) return
        fireService(cm, 'showUnitCellRenderer', {
            sceneId: activeSceneId,
            objId: selectedEntry.objId,
        })
    }, [cm, activeSceneId, selectedEntry])

    // --- Mode menu ---
    const onPickLevelMode = useCallback(
        (useAbs: boolean) => {
            if (!state) return
            if (state.useAbsLevel === useAbs) return
            setProp('use_abslevel', useAbs)
        },
        [state, setProp],
    )

    // Only the plain solid color is editable from this panel; every other
    // colormode is owned by the Coloring panel (see the file header).
    const isSolid = state?.colormode === 'solid'

    /**
     * "Solid color": bring the renderer back to the one mode this panel can
     * edit. A plain `colormode` write (not `setRendererColoring`) because the
     * map renderers without a `coloring` property (contour / gpu_*) would
     * throw on the `resetProp("coloring")` that path performs. No-op when the
     * renderer is already solid.
     */
    const onPickSolidColor = useCallback(() => {
        if (!state || isSolid) return
        setProp('colormode', 'solid')
    }, [state, isSolid, setProp])

    const disabled = state == null

    // --- Level field: prop / unit / range / caption by mode ---
    const levelCtl = useMemo(() => levelControlFor(state), [state])

    // Typed Level entry: the keystrokes stay local (NumericField commits the
    // last parsed value on Enter / blur), shown one decimal finer than the
    // field's step -- the same display precision as the drag fields.
    const [levelDraft, setLevelDraft] = useState<number | null>(null)
    useEffect(() => { setLevelDraft(null) }, [selectedRendId, levelCtl.prop])
    const levelDecimals = decimalsOf(levelCtl.step / 10)

    // --- Level histogram (absolute units; writes `level`) ---
    const [levelDragging, setLevelDragging] = useState(false)
    const levelHisto = useLevelHistogram({
        cm,
        sceneId: activeSceneId,
        rendId: selectedRendId,
        state,
        dragging: levelDragging,
    })
    // The default flag the undo step has to put back, frozen when the gesture
    // starts (a preview frame already clears it).
    const levelWasDefaultRef = useRef(false)
    const onLevelDragStart = useCallback(() => {
        levelWasDefaultRef.current = state?.defaults.siglevel ?? false
        setLevelDragging(true)
    }, [state])
    const onLevelPreview = useCallback(
        (v: number) => setProp('level', v, { mode: 'preview' }),
        [setProp],
    )
    const onLevelCommit = useCallback(
        (v: number, original: number) => {
            // A click commits without a drag: its default flag is the live one.
            const wasDefault = levelDragging
                ? levelWasDefaultRef.current
                : state?.defaults.siglevel ?? false
            setLevelDragging(false)
            setProp('level', v, { mode: 'commit', originalValue: original, originalWasDefault: wasDefault })
        },
        [setProp, levelDragging, state],
    )
    const onLevelAbort = useCallback(
        (original: number) => {
            setLevelDragging(false)
            setProp('level', original, { mode: 'abort', originalWasDefault: levelWasDefaultRef.current })
        },
        [setProp],
    )

    const modeMenu = (
        <Menu>
            <MenuItem
                icon={
                    state?.useAbsLevel === false ? (
                        <AppIcon name="ui.check" aria-hidden />
                    ) : (
                        CHECK_SPACER
                    )
                }
                text={
                    state?.levelUnit === 'percent'
                        ? 'Use top-percent contour level'
                        : 'Use sigma contour level'
                }
                onClick={() => onPickLevelMode(false)}
            />
            <MenuItem
                icon={
                    state?.useAbsLevel === true ? (
                        <AppIcon name="ui.check" aria-hidden />
                    ) : (
                        CHECK_SPACER
                    )
                }
                text="Use absolute contour level"
                onClick={() => onPickLevelMode(true)}
            />
            <MenuDivider />
            <MenuItem
                icon={
                    isSolid ? (
                        <AppIcon name="ui.check" aria-hidden />
                    ) : (
                        CHECK_SPACER
                    )
                }
                text="Solid color"
                onClick={onPickSolidColor}
            />
        </Menu>
    )

    return (
        <ColorPickerProvider cm={cm} sceneId={activeSceneId}>
        <div className="sp-pane">
            <PaneSectionHeader
                title="Density map"
                icon="ui.layers"
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
            />
            {!collapsed && (
                <div className="sp-pane-fill">
                    {/* Renderer selector + mode menu */}
                    <div className="denmap-row">
                        <HTMLSelect
                            value={selectedRendId ?? ''}
                            onChange={(e) => {
                                const v = Number(e.currentTarget.value)
                                setSelectedRendId(Number.isFinite(v) ? v : undefined)
                            }}
                            fill
                            disabled={items.length === 0}
                            className="selection-mol-select h3-form-select"
                        >
                            {items.length === 0 ? (
                                <option value="">(no map renderers)</option>
                            ) : (
                                items.map((it) => (
                                    <option key={it.rendId} value={it.rendId}>
                                        {(it.objName || `Obj ${it.objId}`)
                                            + '/'
                                            + (it.rendName || `Rend ${it.rendId}`)}
                                    </option>
                                ))
                            )}
                        </HTMLSelect>
                        <Popover content={modeMenu} placement="bottom-end" disabled={disabled}>
                            <Button
                                small
                                className="h3-form-dropdown-caret"
                                rightIcon={<span className="h3-form-caret" aria-hidden />}
                                disabled={disabled}
                                aria-label="Level mode"
                            />
                        </Popover>
                    </div>

                    {/* Action row: the two buttons split the pane width. */}
                    <div className="denmap-row denmap-button-row">
                        <Button small onClick={onRedraw} disabled={disabled}>
                            Redraw
                        </Button>
                        <Button small onClick={onShowCell} disabled={disabled}>
                            Cell
                        </Button>
                    </div>

                    {/* Solid-color row. The swatch stays in place but goes
                      * inactive outside solid colormode -- the renderer would
                      * not draw the color it writes. */}
                    <div className="denmap-row">
                        <CueColorField
                            value={state?.color ?? ''}
                            onCommit={(v) => setProp('color', v)}
                            disabled={disabled || !isSolid}
                        />
                    </div>

                    {/* Numeric rows */}
                    <FieldGrid>
                        <DragRow
                            label="Transp"
                            value={state?.alpha ?? 0}
                            min={0}
                            max={1}
                            step={0.1}
                            realtime
                            committedIsDefault={state?.defaults.alpha}
                            onWrite={(v, opts) => setProp('alpha', v, opts)}
                            disabled={disabled}
                        />
                        {/* Extent only shapes the box region; in the full
                          * region (cryo-EM maps) the whole map is marched. */}
                        <DragRow
                            label="Extent"
                            value={state?.extent ?? 0}
                            min={0}
                            max={state?.maxExtent ?? 100}
                            step={1}
                            unit="Å"
                            committedIsDefault={state?.defaults.extent}
                            onWrite={(v, opts) => setProp('extent', v, opts)}
                            disabled={disabled || state?.regionResolved === 'full'}
                        />
                        <LevelHistogramField
                            label="Level"
                            valueField={
                                <NumericField
                                    slider={false}
                                    value={levelDraft ?? levelCtl.value}
                                    decimals={levelDecimals}
                                    onChange={setLevelDraft}
                                    onRelease={(v) => {
                                        setLevelDraft(null)
                                        if (v !== levelCtl.value) setProp(levelCtl.prop, v)
                                    }}
                                    min={levelCtl.min}
                                    max={levelCtl.max}
                                    step={levelCtl.step}
                                    unit={levelCtl.unit || undefined}
                                    disabled={disabled}
                                />
                            }
                            hint={levelCtl.hint || undefined}
                            value={state?.level ?? 0}
                            histogram={levelHisto.histogram}
                            domain={levelHisto.domain ?? { min: 0, max: 1 }}
                            disabled={disabled || levelHisto.domain === null}
                            onDragStart={onLevelDragStart}
                            onPreview={onLevelPreview}
                            onCommit={onLevelCommit}
                            onAbort={onLevelAbort}
                            onDomainChange={levelHisto.setDomain}
                            onWidthChange={levelHisto.setWidthPx}
                            onFit={levelHisto.fit}
                        />
                    </FieldGrid>
                </div>
            )}
        </div>
        </ColorPickerProvider>
    )
}
