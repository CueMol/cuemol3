/**
 * @file worker/server/services/helpers/defPaintColoring.ts
 * @description The app's default Paint coloring -- a `PaintColoring` seeded
 * with the four secondary-structure entries UXP `createDefPaintColoring`
 * (`renderer.js`) builds.
 *
 * Two call sites share it, which is why it lives here rather than beside
 * either: the post-load hook that paints a freshly-created molecule
 * (`molPostProc`), and the Coloring panel / renderer menu's "Paint coloring"
 * -> Default item (`setRendererColoring` with `paint-type-paint`). Building a
 * bare `PaintColoring` there instead left the paint table empty, so the entry
 * looked like it had done nothing.
 *
 * Each molecule is painted in one colour family from a palette theme: the
 * n-th molecule of the scene (in load order) takes the theme's n-th colour,
 * cycling over however many the theme has, and the structures' colours are
 * that colour with a modifier: helix and sheet take it as it is (their
 * shapes tell them apart), the nucleic acid shifts its hue
 * (`okabeito_2{mod_h:15}`), and the coil is washed out to near white. A
 * difference in brightness alone does not read as another colour in 3D,
 * where the shading already varies it; a hue difference does.
 *
 * The themes are global named colours `<theme>_<n>` in
 * `data/cuemol3_style.xml` (loaded by CueMol3 only), and the theme used is the style string
 * `<palette id="default_paint" value="..."/>` (a scene's own definition first,
 * then the global one). The theme only decides how molecules loaded from now
 * on are painted; nothing recolours those already painted.
 *
 * The colour a molecule takes is copied into the scene's own style set first
 * (`ensureSceneColor`). The scene file then carries the definition with the
 * name that refers to it, so an older CueMol that has no such global name
 * still resolves it, and changing the global value later leaves a saved scene
 * as it was.
 *
 * A scene with the CueMol2 (legacy) look (no `cuemol3_look` style set, e.g.
 * one made by CueMol2) is painted as CueMol2 paints it instead: the four
 * fixed colours of UXP `renderer.js`, standard colour names that need no
 * palette nor a copy into the scene's style set.
 *
 * Runs in the Web Worker thread; C++ wrappers are called synchronously.
 */
import type { PaintColoring } from '@cuemol/core/src/wrappers/PaintColoring';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { makeSel } from './makeSel';
import { makeColor } from './makeColor';
import { ensureWritableSceneSet } from '@renderer/worker/server/services/select/saveSelDef';
import { listSceneObjects } from '@renderer/worker/server/services/scene/listSceneObjects';
import { isMoleculeClass } from '@renderer/worker/shared/objectClasses';
import { sceneLookOf } from '@renderer/worker/server/services/scene/sceneLook';

const log = console;

/** The theme used when the style names none, or one with no colours. */
const FALLBACK_THEME = 'okabeito';

/**
 * Selection -> how its colour derives from the molecule's palette colour, in
 * UXP's order. NamedColor modifiers: a hue shift in degrees, saturation and
 * brightness as offsets (clamped to 0-1). A hue shift is written positive
 * (350 for -10): C++ wraps the hue with fmod, which leaves a negative one
 * negative.
 */
const DEFAULT_PAINT_ENTRIES: { sel: string; modifier: string }[] = [
    { sel: 'sheet', modifier: '' },
    { sel: 'helix', modifier: '' },
    { sel: 'nucleic', modifier: '{mod_h:15}' },
    { sel: '*', modifier: '{mod_s:-0.6;mod_b:0.1}' },
];

/** CueMol2's default paint (UXP `renderer.js` `createDefPaintColoring`). */
const LEGACY_PAINT_ENTRIES: { sel: string; color: string }[] = [
    { sel: 'sheet', color: 'SteelBlue' },
    { sel: 'helix', color: 'khaki' },
    { sel: 'nucleic', color: 'yellow' },
    { sel: '*', color: 'FloralWhite' },
];

/** CueMol1's default paint (the `WoodyHSCPaint` style of `data/default_style.xml`). */
const CUEMOL1_PAINT_ENTRIES: { sel: string; color: string }[] = [
    { sel: 'sheet', color: '#7FFF7F' },
    { sel: 'helix', color: '#FF7F7F' },
    { sel: '*', color: '#FFFFBF' },
];

/**
 * What a Paint coloring menu item asks for: CueMol2's or CueMol1's fixed
 * colours, or a theme colour name (`okabeito_3`) to paint the molecule with.
 */
export const PAINT_CHOICE_CUEMOL2 = 'cuemol2';
export const PAINT_CHOICE_CUEMOL1 = 'cuemol1';

/** `#rrggbb` from 0-255 components. */
function toHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map((v) => (v & 0xff).toString(16).padStart(2, '0')).join('');
}

/** Color names a scope defines itself (the global ones are listed apart). */
function colorNames(ctx: WorkerContext, scopeId: number): string[] {
    try {
        return JSON.parse(ctx.styleMgr.getColorDefsJSON(scopeId)) as string[];
    } catch {
        return [];
    }
}

/** A theme's colour names (`<theme>_1`, `<theme>_2`, ...) in order. */
function themeColors(ctx: WorkerContext, theme: string): string[] {
    const re = new RegExp(`^${theme.replace(/[^\w]/g, '')}_(\\d+)$`);
    return colorNames(ctx, 0)
        .map((name) => ({ name, m: re.exec(name) }))
        .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
        .sort((x, y) => Number(x.m[1]) - Number(y.m[1]))
        .map((e) => e.name);
}

/** The name of the theme the scene paints new molecules with ('' when none is set). */
function defaultThemeName(ctx: WorkerContext, sceneUid: number): string {
    try {
        return ctx.styleMgr.getStrData('palette', 'default_paint', sceneUid).trim();
    } catch {
        return '';
    }
}

/** The colours of the theme the scene paints new molecules with. */
function currentTheme(ctx: WorkerContext, sceneUid: number): string[] {
    const theme = defaultThemeName(ctx, sceneUid);
    const colors = theme === '' ? [] : themeColors(ctx, theme);
    if (colors.length > 0) return colors;
    if (theme !== '') log.warn(`palette theme "${theme}" has no colours; using ${FALLBACK_THEME}`);
    return themeColors(ctx, FALLBACK_THEME);
}

/**
 * The palette colour of a molecule: by its place among the scene's molecules
 * in load order (uid order), so the n-th molecule loaded takes the n-th
 * colour of the theme.
 */
function paletteColorOf(ctx: WorkerContext, sceneUid: number, molUid: number, theme: string[]): string {
    const mols = listSceneObjects(ctx, { sceneId: sceneUid }).objects
        .filter((o) => isMoleculeClass(o.className))
        .map((o) => o.uid)
        .sort((x, y) => x - y);
    const index = Math.max(0, mols.indexOf(molUid));
    return theme[index % theme.length];
}

/**
 * Define `name` in the scene's own style set with the value of its global
 * definition, unless the scene defines it already (the user's recolouring, or
 * a loaded scene's). Call inside an undo txn: it may make the style set.
 */
function ensureSceneColor(ctx: WorkerContext, sceneUid: number, name: string): void {
    if (colorNames(ctx, sceneUid).includes(name)) return;
    let hex: string;
    try {
        // Scope 0 is the global one (qlib::invalid_uid).
        const global = ctx.styleMgr.getColor(name, 0);
        hex = toHex(global.r(), global.g(), global.b());
    } catch (e) {
        // No global definition: the paint shows the name unresolved.
        log.warn(`palette colour "${name}" is not defined:`, e);
        return;
    }
    const setId = ensureWritableSceneSet(ctx, sceneUid);
    if (setId === null) return;
    ctx.styleMgr.setColor(name, makeColor(ctx, hex, sceneUid), sceneUid, setId);
}

/** A style string (`<cat id="key" value="..."/>`), '' when there is none. */
function strData(ctx: WorkerContext, cat: string, key: string, sceneUid: number): string {
    try {
        return ctx.styleMgr.getStrData(cat, key, sceneUid).trim();
    } catch {
        return '';
    }
}

/** One theme of the Paint coloring menu, with its colours in order. */
export interface PaintTheme {
    /** Theme name, the prefix of its colour names (`okabeito`). */
    theme: string;
    /** Menu name (`<palette_label>` of the style). */
    label: string;
    /**
     * Colour names (`okabeito_1`, ...), their values in the scene, and their
     * menu names (`<palette_color_label>`; '' when the style gives none).
     */
    colors: { name: string; hex: string; label: string }[];
}

/**
 * The themes the Paint coloring menu offers: those with a `<palette_label>`
 * and at least one colour. The scene's default theme comes first, the rest
 * by label (the style manager keeps no definition order). A colour's value is
 * resolved in the scene, so a scene that redefined it shows its own.
 */
export function listPaintThemes(ctx: WorkerContext, sceneUid: number): PaintTheme[] {
    let names: string[] = [];
    try {
        names = JSON.parse(ctx.styleMgr.getStrDataDefsJSON('palette_label', 0)) as string[];
    } catch {
        names = [];
    }
    const themes: PaintTheme[] = [];
    for (const theme of new Set(names)) {
        const colors: { name: string; hex: string; label: string }[] = [];
        for (const name of themeColors(ctx, theme)) {
            let hex: string;
            try {
                const c = ctx.styleMgr.getColor(name, sceneUid);
                hex = toHex(c.r(), c.g(), c.b());
            } catch {
                // An unresolvable colour is left out of the menu.
                continue;
            }
            colors.push({ name, hex, label: strData(ctx, 'palette_color_label', name, sceneUid) });
        }
        if (colors.length === 0) continue;
        const label = strData(ctx, 'palette_label', theme, sceneUid) || theme;
        themes.push({ theme, label, colors });
    }
    const first = defaultThemeName(ctx, sceneUid);
    return themes.sort((a, b) =>
        Number(b.theme === first) - Number(a.theme === first) || a.label.localeCompare(b.label));
}

/** A PaintColoring of fixed colours (CueMol2's or CueMol1's default). */
function fixedPaintColoring(
    ctx: WorkerContext,
    sceneUid: number,
    entries: { sel: string; color: string }[],
): PaintColoring | null {
    const coloring = ctx.svc.createObj('PaintColoring') as PaintColoring;
    if (!coloring) return null;
    for (const entry of entries) {
        const sel = makeSel(ctx, entry.sel, sceneUid);
        if (!sel) return null;
        coloring.append(sel, makeColor(ctx, entry.color, sceneUid));
    }
    return coloring;
}

/**
 * Build a `PaintColoring` carrying the default painting of one molecule.
 *
 * @param ctx - worker context.
 * @param sceneUid - scene scope for compiling the selections and named
 *   colours. Required: a scene-local name compiled in the global scope
 *   (uid 0) silently fails to resolve, and every caller has a scene in hand,
 *   so a default here would only make that mistake reachable.
 * @param molUid - the molecule painted, which picks its palette colour.
 * @param choice - a menu choice: `cuemol2` / `cuemol1` for those versions'
 *   fixed colours, or a theme colour name to paint with. Omitted, the
 *   colour is picked automatically (as a loaded molecule is painted).
 * @returns the coloring, or null when the object, any selection, or the
 *   palette could not be had (the caller then leaves the coloring alone).
 * @remarks Without a choice, follows the scene's look: the palette for
 *   CueMol3, CueMol2's four fixed colours for the legacy look.
 */
export function createDefPaintColoring(
    ctx: WorkerContext,
    sceneUid: number,
    molUid: number,
    choice?: string,
): PaintColoring | null {
    if (choice === PAINT_CHOICE_CUEMOL1) return fixedPaintColoring(ctx, sceneUid, CUEMOL1_PAINT_ENTRIES);
    if (choice === PAINT_CHOICE_CUEMOL2 || (choice === undefined && sceneLookOf(ctx, sceneUid) === 'cuemol2')) {
        return fixedPaintColoring(ctx, sceneUid, LEGACY_PAINT_ENTRIES);
    }
    let base: string;
    if (choice !== undefined) {
        base = choice;
    } else {
        const theme = currentTheme(ctx, sceneUid);
        if (theme.length === 0) return null;
        base = paletteColorOf(ctx, sceneUid, molUid, theme);
    }
    const coloring = ctx.svc.createObj('PaintColoring') as PaintColoring;
    if (!coloring) return null;
    ensureSceneColor(ctx, sceneUid, base);
    for (const entry of DEFAULT_PAINT_ENTRIES) {
        const sel = makeSel(ctx, entry.sel, sceneUid);
        if (!sel) return null;
        coloring.append(sel, makeColor(ctx, base + entry.modifier, sceneUid));
    }
    return coloring;
}
