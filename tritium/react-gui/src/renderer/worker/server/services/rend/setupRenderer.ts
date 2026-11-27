// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
//
// Why this no longer goes through `NewRendererCommand`:
//
// The auto-generated wrapper setter `cmd.target_object = mol` ends up
// calling `setPropHelper` in `LWrapper.hpp`, which unconditionally calls
// `pthat->setupParentData("target_object")` on the command. That
// overwrites the molecule's `m_thisname` to `"target_object"` and its
// `m_rootuid` to the command's uid. From that point on, every subsequent
// child property assignment on the mol (e.g. `mol.coloring = paint` from
// `molPostProc`, or `rend.coloring = paint` after materialization)
// computes the child's `m_thisname` as `"target_object" + "coloring"` =
// `"target_objectcoloring"` -- a path NestedPropHandler cannot navigate
// because LScrObjBase::setupParentData concatenates without a dot. The
// undo records stored under that broken path then silently fail
// (PaintColUndo -> getProp "target_objectcoloring" not found), so
// nothing reverts on Cmd+Z.
//
// UXP code never uses the command property-setter pattern; it calls
// `mol.createRenderer(type)` directly. This service mirrors that
// approach so the molecule's parent linkage stays at its scene-graph
// default and the undo path through coloring/paint sub-objects works.
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { MolRenderer } from '@cuemol/core/src/wrappers/MolRenderer';
import type { Renderer } from '@cuemol/core/src/wrappers/Renderer';
import type { Scene } from '@cuemol/core/src/wrappers/Scene';
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes';
import { getDefaultStyleName } from '@renderer/worker/server/services/helpers/getDefaultStyleName';
import { resolveMapKind } from '@renderer/worker/server/services/helpers/mapRendererStyles';
import { makeSel } from '@renderer/worker/server/services/helpers/makeSel';
import { molPostProc } from '@renderer/worker/server/services/helpers/molPostProc';
import {
    DISORDER_TARGET_TYPES,
    listRendererNamesByType,
} from '@renderer/worker/server/services/helpers/rendererNames';
import { safeRead } from '@renderer/worker/server/services/helpers/safeRead';
import { focusAllViewsOnNode } from '@renderer/worker/server/services/sceneTree/sceneOps';
import { NON_MOL_CLASSES, isScalarMapClass } from '@renderer/worker/shared/objectClasses';

const log = console;

/**
 * Fit every view of the scene to the new renderer when the caller asked for
 * it (the dialog's center view, `centerView: true`), as the scene pane's
 * Focus button frames it (`focusOnNode`: the centre and the zoom). Called
 * once the renderer's selection and its post-processing are set, so a
 * renderer of one chain frames that chain. Not recorded on its own: it is
 * part of creating the renderer. A preset group frames its molecule, as
 * Focus on the group does.
 *
 * A volume object is excluded: `MapRenderer::getCenter()` returns the map's
 * DISPLAY center, which a fresh renderer has at the origin, so recentering
 * there threw the view off the structure and left the map drawing a box around
 * (0,0,0). What the view should do for a map is a policy of its own
 * (`applyMapCenterPolicy`, run by the caller once the map kind is known).
 */
function fitViewsIfRequested(ctx: WorkerContext, mol: any, rend: Renderer, rendOpts: RendererOptions): void {
    if (!rendOpts.centerView) return;
    if (isScalarMapClass(safeRead(() => mol.getClassName() as string) ?? '')) return;
    const scene = safeRead(() => mol.getScene() as Scene | null) ?? null;
    const rendId = safeRead(() => (rend as unknown as { uid: number }).uid);
    if (!scene || rendId === undefined) return;
    focusAllViewsOnNode(ctx, scene, rendId, 'renderer');
}

/**
 * Point a freshly created disorder overlay at the molecule's first main-chain
 * renderer (UXP `molPostProc` "setup disorder renderer" branch). Without a
 * target the overlay has no backbone to follow and draws nothing, so the
 * renderer would look broken right after creation.
 */
function seedDisorderTarget(mol: any, rend: Renderer, rendererType: string): void {
    if (rendererType !== 'disorder') return;
    try {
        const names = listRendererNamesByType(mol, DISORDER_TARGET_TYPES);
        if (names.length > 0) (rend as unknown as { target: string }).target = names[0];
    } catch (e) {
        log.warn('disorder target setup failed:', e);
    }
}

/**
 * The molecule's post-processing (default paint, `*selection`) when its
 * renderer could not be created: a new molecule kept without a renderer must
 * still get its default colours, or a renderer added later draws it white.
 * Skipped when the caller will remove the object again (`requireRenderer`):
 * the paint writes missing colours into the scene's style set, which
 * removing the object does not undo.
 */
function postProcAfterFailure(ctx: WorkerContext, mol: any, rendOpts: RendererOptions, newObj: boolean): void {
    if (rendOpts.requireRenderer) return;
    if (NON_MOL_CLASSES.includes(safeRead(() => mol.getClassName() as string) ?? '')) return;
    molPostProc(ctx, mol, newObj, safeRead(() => (mol.getScene() as Scene | null)?.uid) ?? 0);
}

/**
 * Create the renderer (or preset renderer group) the options ask for on
 * `mol`, with its default style, selection and molecule post-processing.
 *
 * @param mol - the object to create the renderer on
 * @param rendOpts - the renderer options from the dialog or op
 * @param newObj - true when `mol` was just created (file open, fetch, a new
 *   molecule): only then does it get the default paint coloring. A renderer
 *   added to an existing molecule keeps `mol.coloring`, which the existing
 *   renderers paint from (`$molcol`); resetting it lost the user's colours
 *   (UXP `result.new_obj`, false for New Renderer).
 * @returns the new renderer, or null when it could not be created (the
 *   molecule is post-processed all the same; see `postProcAfterFailure`)
 */
export function setupRenderer(
    ctx: WorkerContext,
    mol: any,
    rendOpts: RendererOptions,
    newObj: boolean,
): Renderer | null {
    if (rendOpts.presetName) {
        // Preset renderer group (UXP doSetupRend /RendPreset$/ branch):
        // C++ creates the *group renderer plus one child per <renderer>
        // node of the preset style; each child gets its sel / style from
        // the style definition and its name as name_prefix + type. Both
        // grp_name and name_prefix are the dialog's rendererName. The
        // caller's undo txn covers all N+1 registrations.
        let rend: Renderer | null = null;
        try {
            rend = mol.createPresetRenderer(
                rendOpts.presetName,
                rendOpts.rendererName,
                rendOpts.rendererName,
            ) as Renderer | null;
        } catch (e) {
            // C++ throws on an unknown style or a non-rendpreset type.
            log.warn(`createPresetRenderer('${rendOpts.presetName}') failed:`, e);
            postProcAfterFailure(ctx, mol, rendOpts, newObj);
            return null;
        }
        if (!rend) {
            postProcAfterFailure(ctx, mol, rendOpts, newObj);
            return null;
        }
        // No name assignment (C++ setName(grp_name) already did it) and no
        // applyStyles (children carry styles from the preset definition;
        // UXP's setDefaultStyles is a no-op on a *group). The dialog's
        // Selection is not applied either: RendGroup has no sel, and the
        // children's sel comes from the preset (the UI disables the
        // Selection field while a preset is picked).
        if (!NON_MOL_CLASSES.includes(mol.getClassName())) {
            molPostProc(ctx, mol, newObj, safeRead(() => (mol.getScene() as Scene | null)?.uid) ?? 0);
        }
        fitViewsIfRequested(ctx, mol, rend, rendOpts);
        return rend;
    }

    // Direct method call -- avoids the `cmd.target_object = mol` setter
    // that would corrupt mol.m_thisname (see file header).
    let rend: Renderer | null = null;
    try {
        rend = mol.createRenderer(rendOpts.rendererType) as Renderer | null;
    } catch (e) {
        // C++ RendererFactory::create throws on an unregistered type.
        log.warn(`createRenderer('${rendOpts.rendererType}') failed:`, e);
    }
    if (!rend) {
        log.warn(`Failed to create renderer of type '${rendOpts.rendererType}'`);
        postProcAfterFailure(ctx, mol, rendOpts, newObj);
        return null;
    }

    if (rendOpts.rendererName) {
        // Setting the name through the typed wrapper still goes through
        // setPropHelper -> setupParentData("name"), but "name" returns a
        // string (not an object), so the early-return in setupParentData
        // (`if (!newval.isObject()) return;`) means no parent-linkage
        // mutation happens. Safe.
        (rend as unknown as { name: string }).name = rendOpts.rendererName;
    }

    // A map renderer takes the style of its map's kind (the file-open path
    // writes the dialog's map_type before creating the renderer).
    const styleName = getDefaultStyleName(rendOpts.rendererType, resolveMapKind(mol) ?? 'xtal');
    if (styleName) {
        rend.applyStyles(styleName);
    }

    log.info('renderer created: rend=', rend);

    const className = mol.getClassName();
    if (!NON_MOL_CLASSES.includes(className)) {
        // Named selections and colours are scoped to the scene's style set
        // (saveSelDef writes them there and getSelDefs offers them to the UI),
        // so compiling in the default global scope made a scene-local name
        // fail to resolve -- the renderer was then created with no selection at
        // all, showing every atom.
        const sceneUid = safeRead(() => (mol.getScene() as Scene | null)?.uid) ?? 0;
        molPostProc(ctx, mol, newObj, sceneUid);
        seedDisorderTarget(mol, rend, rendOpts.rendererType);

        if (rendOpts.selectionEnabled && rendOpts.selection && rendOpts.selection !== '*') {
            const sel = makeSel(ctx, rendOpts.selection, sceneUid);
            if (sel) {
                (rend as unknown as MolRenderer).sel = sel;
            } else {
                log.warn(`selection compile failed: ${rendOpts.selection}`);
            }
        }
    }
    fitViewsIfRequested(ctx, mol, rend, rendOpts);
    return rend;
}
