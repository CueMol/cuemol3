/**
 * @file worker/server/services/coloring/panelList.ts
 * @description Coloring panel / submenu listing + gate services: the
 * "Paint (Secondary str.)" style list (`getPaintColoringStyles`), the Paint
 * submenu gates (`getRendererPaintInfo` / `getObjectPaintInfo`), and the
 * Coloring panel's paint-capable selector list (`listPaintCapableRenderers`).
 *
 * Runs in the Web Worker thread; C++ wrappers are called synchronously.
 */
import type { Renderer } from '@cuemol/core/src/wrappers/Renderer';
import type { MolCoord } from '@cuemol/core/src/wrappers/MolCoord';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import { fetchStyleEntries } from '@renderer/worker/server/services/helpers/styleEntries';
import { listPaintThemes } from '@renderer/worker/server/services/helpers/defPaintColoring';
import { MOLCOL_STYLE_NAME } from '@shared/coloring/paintChoiceMenu';
import {
    getMolFromRenderer,
    getMolSel,
    isSelEmpty,
    getColoringClassName,
    isMultiGradCapable,
    hasColoringProp,
} from './colorTargets';
import type {
    GetPaintColoringStylesArgs,
    GetPaintColoringStylesResult,
    PaintColoringStyleEntry,
    GetRendererPaintInfoArgs,
    GetRendererPaintInfoResult,
    GetObjectPaintInfoArgs,
    GetObjectPaintInfoResult,
    ListPaintCapableRenderersArgs,
    ListPaintCapableRenderersResult,
    PaintCapableRendererEntry,
} from './types';

const PAINT_RE = /Paint$/;

/**
 * CueMol1's default paint. The Paint coloring menu offers it as "CueMol1
 * default", a PaintColoring of the same colours (so an object can take it
 * too), instead of this style.
 */
const CUEMOL1_STYLE_NAME = 'WoodyHSCPaint';

/** Styles kept out of the preset list (each has its own menu item). */
const NOT_PRESET: ReadonlySet<string> = new Set([MOLCOL_STYLE_NAME, CUEMOL1_STYLE_NAME]);

/**
 * Menu order of the stock single-hue presets (`data/default_style.xml`), by
 * hue. The style manager lists names alphabetically (Blue, Cyan, ...).
 * Styles not listed here (a user's own) follow, in the order listed.
 */
const PRESET_ORDER: readonly string[] = [
    'RedHSCPaint',
    'OrangeHSCPaint',
    'YellowHSCPaint',
    'GreenHSCPaint',
    'CyanHSCPaint',
    'BlueHSCPaint',
    'PurpleHSCPaint',
];

function presetRank(name: string): number {
    const i = PRESET_ORDER.indexOf(name);
    return i < 0 ? PRESET_ORDER.length : i;
}

/**
 * Collect style names ending in `Paint` for the renderer Coloring submenu's
 * "Paint (Secondary str.)" sub-submenu. Merges the global style set
 * (sceneId 0) with the scene-local set so the active scene's user styles
 * are included.
 */
export function getPaintColoringStyles(
    ctx: WorkerContext,
    args: GetPaintColoringStylesArgs,
): GetPaintColoringStylesResult {
    const merged = [
        ...fetchStyleEntries(ctx, 0),
        ...fetchStyleEntries(ctx, args.sceneId),
    ];
    const entries: PaintColoringStyleEntry[] = [];
    for (const raw of merged) {
        const name = typeof raw?.name === 'string' ? raw.name : '';
        if (!name || !PAINT_RE.test(name) || NOT_PRESET.has(name)) continue;
        const desc = typeof raw?.desc === 'string' ? raw.desc : '';
        entries.push({ name, label: desc || name });
    }
    // Array.prototype.sort is stable: unlisted styles keep their order.
    entries.sort((a, b) => presetRank(a.name) - presetRank(b.name));
    return { ok: true, entries, themes: listPaintThemes(ctx, args.sceneId) };
}

/** The CPK styles the renderer Coloring submenu offers beside the Paint ones. */
const CPK_COLORING_STYLES: readonly string[] = ['DefaultCPKColoring', 'DarkCPKColoring', 'LightCPKColoring'];

/**
 * The B-factor gradient style an AlphaFold model is coloured with (pLDDT,
 * ChimeraX's colormap; `data/cuemol3_style.xml`).
 */
export const PLDDT_COLORING_STYLE = 'AlphaFoldPlddtColoring';

/**
 * Every colouring style name a renderer can be given by name: the Paint
 * styles, the CPK ones (as the Coloring submenu offers them) and the pLDDT one.
 */
export function coloringStyleNames(ctx: WorkerContext, sceneId: number): string[] {
    const paint = getPaintColoringStyles(ctx, { sceneId });
    return [
        MOLCOL_STYLE_NAME,
        CUEMOL1_STYLE_NAME,
        ...(paint.ok ? paint.entries.map((e) => e.name) : []),
        ...CPK_COLORING_STYLES,
        PLDDT_COLORING_STYLE,
    ];
}

/**
 * Gate query: whether the renderer Paint submenu should be shown now -
 * true iff the coloring is `PaintColoring` and the parent mol has a
 * non-empty selection.
 */
export function getRendererPaintInfo(
    ctx: WorkerContext,
    args: GetRendererPaintInfoArgs,
): GetRendererPaintInfoResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { canPaint: false };
    const rend = scene.getRenderer(args.rendId) as Renderer | null;
    if (!rend) return { canPaint: false };
    if (getColoringClassName(rend) !== 'PaintColoring') return { canPaint: false };
    const mol = getMolFromRenderer(rend);
    if (!mol) return { canPaint: false };
    const sel = getMolSel(mol);
    if (!sel || isSelEmpty(sel)) return { canPaint: false };
    return { canPaint: true };
}

/**
 * Gate query for the object Paint submenu: true iff the object has a
 * non-empty selection.
 *
 * @remarks The coloring class is intentionally not gated here - the menu
 * surfaces as soon as something is selected, and `paintObjectSelection`
 * refuses safely when the coloring is not `PaintColoring`, so a stray
 * click is a no-op rather than a crash.
 */
export function getObjectPaintInfo(
    ctx: WorkerContext,
    args: GetObjectPaintInfoArgs,
): GetObjectPaintInfoResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { canPaint: false };
    const mol = scene.getObject(args.objId) as MolCoord | null;
    if (!mol) return { canPaint: false };
    const sel = getMolSel(mol);
    if (!sel || isSelEmpty(sel)) return { canPaint: false };
    return { canPaint: true };
}

interface RawSceneObjItem {
    name?: string;
    type?: string;
    ID?: number;
    rends?: RawSceneRendItem[];
}

interface RawSceneRendItem {
    name?: string;
    type?: string;
    ID?: number;
    childNodes?: RawSceneRendItem[];
}

function collectRendsRecursive(
    items: RawSceneRendItem[] | undefined,
    out: { id: number; name: string; typeName: string }[],
): void {
    if (!Array.isArray(items)) return;
    for (const it of items) {
        if (typeof it?.ID === 'number') {
            out.push({
                id: it.ID,
                name: it.name ?? '',
                typeName: it.type ?? '',
            });
        }
        if (Array.isArray(it.childNodes)) {
            collectRendsRecursive(it.childNodes, out);
        }
    }
}

/**
 * Build the selector list for the Coloring panel.
 *
 * Mirrors UXP `paint_coloring_filter`, which accepts both top-level
 * objects (`elem.cat === 'obj'`) and renderers (`elem.cat === 'rend'`)
 * with a `coloring` property. The returned list interleaves an object
 * row followed by its paint-capable child renderer rows, so a grouped
 * selector renders the molecule and its sub-renderers together.
 *
 * Renderer groups have no coloring of their own and are skipped (only
 * their leaf renderers contribute rows).
 */
export function listPaintCapableRenderers(
    ctx: WorkerContext,
    args: ListPaintCapableRenderersArgs,
): ListPaintCapableRenderersResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false, renderers: [] };

    let parsed: unknown;
    try {
        parsed = JSON.parse(scene.getSceneDataJSON());
    } catch {
        return { ok: false, renderers: [] };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: false, renderers: [] };
    }

    const out: PaintCapableRendererEntry[] = [];
    // Skip index 0 (the scene element); the rest are objects.
    for (let i = 1; i < parsed.length; i++) {
        const obj = parsed[i] as RawSceneObjItem;
        if (typeof obj?.ID !== 'number') continue;
        const objWrap = scene.getObject(obj.ID);
        if (objWrap && hasColoringProp(objWrap)) {
            out.push({
                targetKind: 'object',
                rendId: obj.ID,
                name: obj.name ?? '',
                typeName: obj.type ?? '',
                objId: obj.ID,
                objName: obj.name ?? '',
            });
        }
        const rendList: { id: number; name: string; typeName: string }[] = [];
        collectRendsRecursive(obj.rends, rendList);
        for (const r of rendList) {
            // UXP `paint_coloring_filter` excludes the selection-display
            // renderer (the per-mol "*selection" overlay). It exposes a
            // `coloring` property but is not user-editable.
            if (r.typeName === '*selection') continue;
            const rend = scene.getRenderer(r.id) as Renderer | null;
            if (!rend) continue;
            // Map renderers (contour / isosurf / gpu_*) have no `coloring`
            // property but are colorable via their `multi_grad` gradient, so
            // they qualify for the panel too.
            if (!hasColoringProp(rend) && !isMultiGradCapable(rend)) {
                continue;
            }
            out.push({
                targetKind: 'renderer',
                rendId: r.id,
                name: r.name,
                typeName: r.typeName,
                objId: obj.ID,
                objName: obj.name ?? '',
            });
        }
    }
    return { ok: true, renderers: out };
}
