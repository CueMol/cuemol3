/**
 * @file worker/shared/molStructInfo.ts
 * @description What the inspector shows for one chain, residue or atom of a
 * molecule (Mol Struct pane > Properties). Read-only values as the worker
 * reads them; the inspector formats them.
 */

/** The chain / residue / atom asked about, as the Mol Struct tree names it. */
export type MolStructRef =
    | { kind: 'chain'; chain: string }
    | { kind: 'resid'; chain: string; index: string }
    | { kind: 'atom'; chain: string; index: string; atomId: number };

export interface MolChainInfo {
    kind: 'chain';
    name: string;
    residueCount: number;
    /** Residue numbers of the first and last residue (null for an empty chain). */
    firstResidue: string | null;
    lastResidue: string | null;
}

export interface MolResidueInfo {
    kind: 'resid';
    chain: string;
    /** Residue number with its insertion code ("10A"). */
    index: string;
    name: string;
    atomCount: number;
    /**
     * The residue's `secondary` property ("helix" / "sheet"; empty when not
     * set, which renderers draw as coil) and `secondary2` (the helix kind
     * H / G / I or E for a strand, with s / e marking the first / last
     * residue; empty when not set).
     */
    secondary: string;
    secondary2: string;
    /** Has a CA atom: an unset `secondary` then means coil rather than not a polymer residue. */
    hasCA: boolean;
}

export interface MolAtomInfo {
    kind: 'atom';
    /** CueMol's own atom id (not the file's serial number). */
    id: number;
    name: string;
    element: string;
    chain: string;
    residueIndex: string;
    residueName: string;
    /** Alternate conformation id; empty when none. */
    altloc: string;
    pos: [number, number, number];
    bfac: number;
    occ: number;
}

export type MolStructInfo = MolChainInfo | MolResidueInfo | MolAtomInfo;
