/**
 * @file worker/shared/superposeTypes.ts
 * @description Superposition algorithm ids and US-align pivot atoms, shared by
 * the worker service (`superposeMol`), the catalog op, the PyMOL dialect and
 * the Superpose dialog.
 */

/**
 * Superposition algorithm: US-align (TM-align; proteins and nucleic acids,
 * the default), secondary-structure matching (proteins), or a least-squares
 * fit of atoms paired in order.
 */
export type SuperposeAlgo = 'USalign' | 'SSM' | 'LSQ';

/** The default algorithm of every superposition entry point. */
export const DEFAULT_SUPERPOSE_ALGO: SuperposeAlgo = 'USalign';

/**
 * US-align pivot atom choices: 'auto' takes CA for amino acids and C3' for
 * nucleotides; the others use that atom for every residue.
 */
export const USALIGN_PIVOTS = ['auto', 'CA', "C3'", "C4'", 'P'] as const;

/**
 * What a superposition achieved, as `MolAnlManager.getLastSuperposeJSON`
 * reports it. `nalgn` counts the aligned residues (USalign, SSM) or the
 * fitted atoms (LSQ); `rotation` is the rotation angle in degrees (-1 when it
 * could not be determined).
 */
export interface SuperposeStats {
  algo: SuperposeAlgo;
  rmsd: number;
  nalgn: number;
  rotation: number;
  /** USalign: TM-score normalised by the reference / moving chain. */
  tm_ref?: number;
  tm_mov?: number;
  /** USalign: identical residues in the aligned pairs / nalgn. */
  seqid?: number;
  nucleic?: boolean;
  /** SSM: gaps in the alignment. */
  ngaps?: number;
}
