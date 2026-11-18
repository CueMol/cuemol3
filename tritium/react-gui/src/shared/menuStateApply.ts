/**
 * Pure menu-state helpers shared between main and renderer tests.
 *
 * main/menu.ts holds a `lastMenuState` cache because the native menu
 * is rebuilt after every MRU change (RECENT_ADD / RECENT_CLEAR), which
 * replaces every MenuItem instance -- the `enabled` / `checked` flags
 * that `updateMenuState()` wrote to the previous MenuItems are
 * therefore lost unless we reapply them to the new ones.
 *
 * `mergeMenuState` keeps the cache up-to-date when partial updates
 * arrive (the renderer sends only the slices that changed, e.g.
 * `viewProjection` alone after a UI toggle). `applyMenuStateTo` then
 * writes the merged cache onto whichever menu we have at hand -- old
 * one in the steady-state path, freshly built one in the post-rebuild
 * path.
 */

import type { MenuState } from './types/menuState'
import { SCENE_EXPORT_MENU_EXPORTERS } from './menuTemplate'
import { isAvailable } from './guiGate'
import type { Availability } from './guiGate'

/**
 * A menu item the GUI gate applies to: what it declares, and the enabled flag
 * it has when its own state says nothing (the template's `enabled`, else true).
 */
export interface GatedMenuItem {
    availability?: Availability
    enabled: boolean
}

/** Minimal MenuItem surface that the apply helper mutates. */
export interface MenuItemLike {
    enabled: boolean
    checked: boolean
    /** Electron MenuItem visibility; toggled for capability-gated export items. */
    visible?: boolean
}

/** Minimal Menu surface used by the apply helper. */
export interface MenuLike {
    getMenuItemById(id: string): MenuItemLike | null
}

/**
 * Merge a new partial state into an existing cache. Each top-level
 * slice (`viewProjection` / `viewCenterMark` / `sceneBgColor`) is
 * replaced atomically -- that mirrors how the renderer sends them
 * (always a complete slice, never field-level patches).
 */
export function mergeMenuState(
    current: MenuState | null,
    update: MenuState,
): MenuState {
    return {
        viewProjection: update.viewProjection ?? current?.viewProjection,
        viewCenterMark: update.viewCenterMark ?? current?.viewCenterMark,
        sceneBgColor: update.sceneBgColor ?? current?.sceneBgColor,
        sceneColorProof: update.sceneColorProof ?? current?.sceneColorProof,
        toolPalette: update.toolPalette ?? current?.toolPalette,
        undo: update.undo ?? current?.undo,
        redo: update.redo ?? current?.redo,
        guiGate: update.guiGate ?? current?.guiGate,
        exportCaps: update.exportCaps ?? current?.exportCaps,
    }
}

/**
 * Write a (possibly merged) state onto a menu by id-based lookup.
 * Items that the menu doesn't have are skipped silently -- callers
 * may pass a state slice for a menu that was just rebuilt and is
 * still missing the right ids.
 *
 * An item's `enabled` is its own state (a slice below, else its
 * `GatedMenuItem.enabled` default) AND the GUI gate. Both are recomputed on
 * every call, so the gate turning back on re-enables an item it had disabled.
 *
 * @param gated - every gated item in `menu`, by id (static items and the
 *   dynamic Open Recent rows alike). Items absent from it are never gated.
 */
export function applyMenuStateTo(
    menu: MenuLike,
    state: MenuState,
    gated: ReadonlyMap<string, GatedMenuItem> = new Map(),
): void {
    // The enabled flag each item's own state asks for; written out at the end
    // together with the gate.
    const own = new Map<string, boolean>()

    if (state.viewProjection) {
        const { enabled, perspective } = state.viewProjection
        const perspectiveItem = menu.getMenuItemById('view-perspective')
        const orthographicItem = menu.getMenuItemById('view-orthographic')
        own.set('view-perspective', enabled)
        own.set('view-orthographic', enabled)
        if (perspectiveItem) perspectiveItem.checked = enabled && perspective === true
        if (orthographicItem) orthographicItem.checked = enabled && perspective === false
    }

    if (state.viewCenterMark) {
        const { enabled, centerMark } = state.viewCenterMark
        const markItems = [
            { id: 'center-mark-none', value: 'none' as const },
            { id: 'center-mark-cross', value: 'crosshair' as const },
            { id: 'center-mark-axis', value: 'axis' as const },
        ]
        for (const { id, value } of markItems) {
            own.set(id, enabled)
            const item = menu.getMenuItemById(id)
            if (item) item.checked = enabled && centerMark === value
        }
    }

    if (state.sceneColorProof) {
        const { enabled, checked } = state.sceneColorProof
        own.set('color-proof', enabled)
        const item = menu.getMenuItemById('color-proof')
        if (item) item.checked = enabled && checked
    }

    if (state.toolPalette) {
        const item = menu.getMenuItemById('view-tool-palette')
        if (item) item.checked = state.toolPalette.visible
    }

    if (state.sceneBgColor) {
        const { enabled, bgColor } = state.sceneBgColor
        const bgItems = [
            { id: 'bg-white', value: 'white' as const },
            { id: 'bg-black', value: 'black' as const },
        ]
        for (const { id, value } of bgItems) {
            own.set(id, enabled)
            const item = menu.getMenuItemById(id)
            if (item) item.checked = enabled && bgColor === value
        }
    }

    if (state.undo) own.set('undo', state.undo.enabled)
    if (state.redo) own.set('redo', state.redo.enabled)

    // Until the renderer reports a gate, nothing is gated: the menu built at
    // window creation predates the renderer.
    const gate = state.guiGate
    for (const id of new Set([...own.keys(), ...gated.keys()])) {
        const item = menu.getMenuItemById(id)
        if (!item) continue
        const entry = gated.get(id)
        const ownEnabled = own.get(id) ?? entry?.enabled ?? true
        item.enabled = ownEnabled && (!entry || !gate || isAvailable(entry.availability, gate))
    }

    // Hide scene-export menu items whose exporter is not registered in this
    // libcuemol2 build (e.g. Umbreon without HAVE_UMBREON). Gating is fail-open:
    // an empty availability set (unknown / probe failed) leaves every item
    // visible, since a successful probe always includes the always-built 'png'.
    if (state.exportCaps && state.exportCaps.available.length > 0) {
        const available = new Set(state.exportCaps.available)
        for (const [id, exporter] of Object.entries(SCENE_EXPORT_MENU_EXPORTERS)) {
            const item = menu.getMenuItemById(id)
            if (item) item.visible = available.has(exporter)
        }
    }
}
