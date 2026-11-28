// Runs in Web Worker thread. Wrappers are sync (no await on C++ wrappers).
//
// MolStructPane (UXP `panel.molstruct`) data source for chain /
// residue / atom enumeration of one already-selected mol. Mol
// enumeration (the selector dropdown) lives in
// `listSceneObjects.service` and the `ObjectSelect` widget; this
// file only walks downward from a known molId.
//
// UXP reference: uxp_gui/cuemol2/base/content/molstruct-panel.js.

import type { Object as CueMolObject } from '@cuemol/core/src/wrappers/Object';
import type { MolCoord } from '@cuemol/core/src/wrappers/MolCoord';
import type { MolChain } from '@cuemol/core/src/wrappers/MolChain';
import type { MolResidue } from '@cuemol/core/src/wrappers/MolResidue';
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext';
import type { MolAtom } from '@cuemol/core/src/wrappers/MolAtom';
import { getSceneOrNull } from '@renderer/worker/server/services/helpers/sceneResolver';
import { fail, failFrom, ok, type Result } from '@renderer/worker/shared/result';
import type { MolStructInfo, MolStructRef } from '@renderer/worker/shared/molStructInfo';

export interface GetMolChainsArgs {
    sceneId: number;
    molId: number;
}

export interface MolChainEntry {
    /** Single-letter (or short) chain name, e.g. "A". */
    name: string;
}

export interface GetMolChainsResult {
    ok: boolean;
    chains: MolChainEntry[];
}

export interface GetMolResiduesArgs {
    sceneId: number;
    molId: number;
    chainName: string;
}

export interface MolResidueEntry {
    /**
     * ResidIndex serialised by C++ (e.g. "10" or "10A" -- insertion codes
     * are preserved). Keep as string in the wire format so callers can
     * round-trip the exact UXP selection-string syntax.
     */
    index: string;
    name: string;
    /** Single-letter residue code (UXP `getResidsJSON` `single` field). */
    single: string;
    /**
     * Whether this residue is in the molecule's current `sel`. Used by
     * the sequence panel for cyan highlighting; the molstruct tree
     * ignores it.
     */
    sel: boolean;
}

export interface GetMolResiduesResult {
    ok: boolean;
    residues: MolResidueEntry[];
}

export interface GetMolAtomsArgs {
    sceneId: number;
    molId: number;
    chainName: string;
    residueIndex: string;
}

export interface MolAtomEntry {
    id: number;
    name: string;
    elem: string;
}

export interface GetMolAtomsResult {
    ok: boolean;
    atoms: MolAtomEntry[];
}

/**
 * Probe a Scene object for MolCoord-like behaviour via duck typing on
 * `getChainsJSON`. This mirrors UXP `cuemol.implIface(elem.type,
 * "MolCoord")` without hard-coding the (small) set of derived class names.
 */
function isMolCoordLike(obj: CueMolObject | null): obj is MolCoord {
    if (!obj) return false;
    const candidate = obj as unknown as { getChainsJSON?: unknown };
    return typeof candidate.getChainsJSON === 'function';
}

function parseChainsJSON(json: string): MolChainEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: MolChainEntry[] = [];
    for (const entry of parsed) {
        // UXP `getChainsJSON()` emits an array of plain strings
        // (one per chain name). Accept either string or { name }
        // for forward-compatibility.
        if (typeof entry === 'string') {
            out.push({ name: entry });
        } else if (entry && typeof (entry as { name?: unknown }).name === 'string') {
            out.push({ name: (entry as { name: string }).name });
        }
    }
    return out;
}

export function getMolChains(ctx: WorkerContext, args: GetMolChainsArgs): GetMolChainsResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false, chains: [] };
    const obj = scene.getObject(args.molId) as CueMolObject | null;
    if (!isMolCoordLike(obj)) return { ok: false, chains: [] };

    let json: string;
    try {
        json = obj.getChainsJSON();
    } catch {
        return { ok: false, chains: [] };
    }
    return { ok: true, chains: parseChainsJSON(json) };
}

interface RawResidueEntry {
    name?: unknown;
    single?: unknown;
    index?: unknown;
    sel?: unknown;
}

function parseResiduesJSON(json: string): MolResidueEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: MolResidueEntry[] = [];
    for (const raw of parsed as RawResidueEntry[]) {
        // C++ MolChain::getResidsJSON emits `index` as a string
        // (ResidIndex::toString()) so insertion codes survive.
        const index = typeof raw?.index === 'string' ? raw.index : String(raw?.index ?? '');
        if (!index) continue;
        out.push({
            index,
            name: typeof raw?.name === 'string' ? raw.name : '',
            single: typeof raw?.single === 'string' ? raw.single : '',
            sel: raw?.sel === true,
        });
    }
    return out;
}

export function getMolResidues(
    ctx: WorkerContext,
    args: GetMolResiduesArgs,
): GetMolResiduesResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false, residues: [] };
    const mol = scene.getObject(args.molId) as MolCoord | null;
    if (!mol) return { ok: false, residues: [] };

    let chain: MolChain | null;
    try {
        chain = mol.getChain(args.chainName) as MolChain | null;
    } catch {
        return { ok: false, residues: [] };
    }
    if (!chain) return { ok: false, residues: [] };

    let json: string;
    try {
        json = chain.getResidsJSON();
    } catch {
        return { ok: false, residues: [] };
    }
    return { ok: true, residues: parseResiduesJSON(json) };
}

interface RawAtomEntry {
    name?: unknown;
    id?: unknown;
    elem?: unknown;
}

function parseAtomsJSON(json: string): MolAtomEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: MolAtomEntry[] = [];
    for (const raw of parsed as RawAtomEntry[]) {
        const id = typeof raw?.id === 'number' ? raw.id : Number(raw?.id);
        if (!Number.isFinite(id)) continue;
        out.push({
            id,
            name: typeof raw?.name === 'string' ? raw.name : '',
            elem: typeof raw?.elem === 'string' ? raw.elem : '',
        });
    }
    return out;
}

export function getMolAtoms(
    ctx: WorkerContext,
    args: GetMolAtomsArgs,
): GetMolAtomsResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return { ok: false, atoms: [] };
    const mol = scene.getObject(args.molId) as MolCoord | null;
    if (!mol) return { ok: false, atoms: [] };

    let chain: MolChain | null;
    try {
        chain = mol.getChain(args.chainName) as MolChain | null;
    } catch {
        return { ok: false, atoms: [] };
    }
    if (!chain) return { ok: false, atoms: [] };

    let residue: MolResidue | null;
    try {
        // MolChain.getResidue takes a ResidIndex string ("10" / "10A").
        residue = chain.getResidue(args.residueIndex) as MolResidue | null;
    } catch {
        return { ok: false, atoms: [] };
    }
    if (!residue) return { ok: false, atoms: [] };

    let json: string;
    try {
        json = residue.getAtomsJSON();
    } catch {
        return { ok: false, atoms: [] };
    }
    return { ok: true, atoms: parseAtomsJSON(json) };
}

export interface GetMolStructInfoArgs {
    sceneId: number;
    molId: number;
    target: MolStructRef;
}

export type GetMolStructInfoResult = Result<{ info: MolStructInfo }>;

/** Count the entries of a JSON array string (0 when it does not parse). */
function jsonArrayLength(json: string): number {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}

/** The values of one chain / residue / atom, for the read-only inspector page. */
function readMolStructInfo(mol: MolCoord, target: MolStructRef): MolStructInfo | null {
    if (target.kind === 'atom') {
        const atom = mol.getAtomByID(target.atomId) as MolAtom | null;
        if (!atom) return null;
        const pos = atom.pos as unknown as { x: number; y: number; z: number };
        return {
            kind: 'atom',
            id: target.atomId,
            name: atom.name,
            element: atom.element,
            chain: atom.chainName,
            residueIndex: atom.residIndex,
            residueName: atom.residName,
            altloc: atom.confid,
            pos: [pos.x, pos.y, pos.z],
            bfac: atom.bfac,
            occ: atom.occ,
        };
    }
    const chain = mol.getChain(target.chain) as MolChain | null;
    if (!chain) return null;
    if (target.kind === 'chain') {
        const residues = parseResiduesJSON(chain.getResidsJSON());
        return {
            kind: 'chain',
            name: target.chain,
            residueCount: residues.length,
            firstResidue: residues[0]?.index ?? null,
            lastResidue: residues[residues.length - 1]?.index ?? null,
        };
    }
    const res = chain.getResidue(target.index) as MolResidue | null;
    if (!res) return null;
    return {
        kind: 'resid',
        chain: target.chain,
        index: res.sindex,
        name: res.name,
        atomCount: jsonArrayLength(res.getAtomsJSON()),
        secondary: res.getPropStr('secondary'),
        secondary2: res.getPropStr('secondary2'),
        hasCA: !!res.getAtom('CA'),
    };
}

/**
 * Read one chain, residue or atom of a molecule (Mol Struct pane >
 * Properties). Read-only, so no undo txn. `not-found` when the molecule or
 * the part is gone (deleted, or a renumbered chain).
 */
export function getMolStructInfo(ctx: WorkerContext, args: GetMolStructInfoArgs): GetMolStructInfoResult {
    const scene = getSceneOrNull(ctx, args.sceneId);
    if (!scene) return fail(`scene ${args.sceneId} not found`, 'not-found');
    const obj = scene.getObject(args.molId) as CueMolObject | null;
    if (!isMolCoordLike(obj)) return fail(`molecule ${args.molId} not found`, 'not-found');
    try {
        const info = readMolStructInfo(obj, args.target);
        if (!info) return fail('no such chain, residue or atom', 'not-found');
        return ok({ info });
    } catch (e) {
        return failFrom(e, 'native');
    }
}
