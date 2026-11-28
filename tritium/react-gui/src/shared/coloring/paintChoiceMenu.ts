/**
 * @file shared/coloring/paintChoiceMenu.ts
 * @description The items of the "Paint coloring" submenu, shared by the
 * Coloring panel's mode dropdown and the scene tree's renderer context menu
 * (both shown as the platform menu), so the two list the same choices in the
 * same order.
 *
 * Every item gives the target a fresh PaintColoring: CueMol2's / CueMol1's
 * fixed colours, a palette theme colour (one submenu per theme, each colour
 * by its name with a swatch), or -- for a renderer -- a `*Paint` style preset.
 */

import type { RendColoringId } from '@shared/types/sceneCtxMenu'
import type { MenuNode } from '@shared/menuNodes'

/**
 * The `$molcol` style (SolidColoring taking the molecule's colour), offered as
 * the renderer's "Molecule color" item rather than among the Paint presets.
 */
export const MOLCOL_STYLE_NAME = 'DefaultHSCPaint'
export const MOLCOL_COLORING_ID: RendColoringId = `style-${MOLCOL_STYLE_NAME}`

/** A palette theme as the menu needs it. */
export interface PaintThemeMenuEntry {
    label: string
    /** `label` is the colour's menu name ('' lists it by its number). */
    colors: { name: string; hex: string; label: string }[]
}

/** A `*Paint` style preset (renderer only). */
export interface PaintPresetMenuEntry {
    name: string
    label: string
}

/**
 * The Paint coloring submenu, its actions the coloring ids to apply.
 * `presets` is empty for an object, which cannot take a style. Separators
 * stand between the groups (an empty group's are collapsed by the renderers).
 *
 * @param action - maps a coloring id to the menu's action value.
 */
export function paintChoiceMenu<T>(
    themes: PaintThemeMenuEntry[],
    presets: PaintPresetMenuEntry[],
    action: (coloringId: RendColoringId) => T,
): MenuNode<T>[] {
    const item = (label: string, coloringId: RendColoringId, swatch?: string): MenuNode<T> => ({
        label,
        ...(swatch ? { swatch } : {}),
        action: action(coloringId),
    })
    return [
        item('CueMol2 default', 'paint-type-paint-cuemol2'),
        item('CueMol1 (woody)', 'paint-type-paint-cuemol1'),
        { type: 'separator' },
        ...themes.map((t): MenuNode<T> => ({
            label: t.label,
            submenu: t.colors.map((c, i) => item(c.label || String(i + 1), `paint-theme-${c.name}`, c.hex)),
        })),
        { type: 'separator' },
        ...presets.map((p) => item(p.label, `style-${p.name}`)),
    ]
}
