/**
 * @file features/inspector/MolStructInspector.tsx
 * @description Read-only inspector page for one chain, residue or atom of a
 * molecule, opened from the Mol Struct pane's Properties button.
 *
 * A `FlatSection` of `PropertyField` rows with read-only `TextField`s (the
 * same layout as `ActionStepInspector`). The page refetches when the
 * molecule changes (an edit, undo / redo) and reports `onGone` when the
 * molecule or the part no longer exists, so the inspector empties.
 *
 * UXP's Mol Struct panel had a Properties button with an empty handler
 * (`molstruct-panel.js` `onBtnPropCmd`); this page is new in tritium.
 */

import React, { useCallback, useEffect } from 'react'
import { PropertyField, TextField } from '@renderer/h3-kit/form'
import { FlatSection } from './AccordionSection'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import { useLiveFetch } from '@renderer/hooks/cuemol/useLiveFetch'
import { SEM_ANY, SEM_OBJECT } from '@renderer/event'
import { EVENT_BURST_DEBOUNCE_MS } from '@renderer/utils/timing'
import type {
  MolAtomInfo,
  MolChainInfo,
  MolResidueInfo,
  MolStructInfo,
  MolStructRef,
} from '@renderer/worker/shared/molStructInfo'

interface MolStructInspectorProps {
  cm: AsyncCueMol
  sceneId: number
  molId: number
  part: MolStructRef
  /** The molecule or the part went away. */
  onGone: () => void
  /** Report the header (name, type label) the inspector shows. */
  onHeaderChange: (name: string, type: string) => void
}

interface PageState {
  info: MolStructInfo | null
  gone: boolean
}

const EMPTY: PageState = { info: null, gone: false }

/** A read-only value; selectable, so it can be copied out. */
const Value: React.FC<{ text: string; mono?: boolean }> = ({ text, mono }) => (
  <TextField value={text} onChange={() => undefined} readOnly mono={mono} />
)

/** Helix kinds of the residue's `secondary2` (its first letter). */
const HELIX_KINDS: Record<string, string> = {
  H: 'Helix (alpha)',
  G: 'Helix (3-10)',
  I: 'Helix (pi)',
}

/**
 * The residue's secondary structure in words. An unset value is coil for a
 * residue with a CA atom (as the renderers draw it), and nothing otherwise.
 */
export function secondaryLabel(info: Pick<MolResidueInfo, 'secondary' | 'secondary2' | 'hasCA'>): string {
  if (info.secondary === 'helix') return HELIX_KINDS[info.secondary2.charAt(0)] ?? 'Helix'
  if (info.secondary === 'sheet') return 'Sheet'
  if (info.secondary) return info.secondary
  return info.hasCA ? 'Coil' : '-'
}

/** Format a coordinate or other real value with a fixed number of decimals. */
function fixed(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : String(v)
}

const ChainFields: React.FC<{ info: MolChainInfo }> = ({ info }) => (
  <FlatSection title="Chain">
    <PropertyField label="Name">
      <Value text={info.name} />
    </PropertyField>
    <PropertyField label="Residues">
      <Value text={String(info.residueCount)} />
    </PropertyField>
    {info.firstResidue !== null && (
      <PropertyField label="Range">
        <Value text={`${info.firstResidue} - ${info.lastResidue ?? info.firstResidue}`} />
      </PropertyField>
    )}
  </FlatSection>
)

const ResidueFields: React.FC<{ info: MolResidueInfo }> = ({ info }) => (
  <FlatSection title="Residue">
    <PropertyField label="Chain">
      <Value text={info.chain} />
    </PropertyField>
    <PropertyField label="Number">
      <Value text={info.index} />
    </PropertyField>
    <PropertyField label="Name">
      <Value text={info.name} />
    </PropertyField>
    <PropertyField label="Atoms">
      <Value text={String(info.atomCount)} />
    </PropertyField>
    <PropertyField label="Secondary">
      <Value text={secondaryLabel(info)} />
    </PropertyField>
  </FlatSection>
)

const AtomFields: React.FC<{ info: MolAtomInfo }> = ({ info }) => (
  <FlatSection title="Atom">
    <PropertyField label="Name">
      <Value text={info.name} />
    </PropertyField>
    <PropertyField label="Element">
      <Value text={info.element} />
    </PropertyField>
    <PropertyField label="Residue">
      <Value text={`${info.chain}.${info.residueIndex} ${info.residueName}`} />
    </PropertyField>
    {info.altloc && (
      <PropertyField label="Altloc">
        <Value text={info.altloc} />
      </PropertyField>
    )}
    <PropertyField label="Position">
      <Value text={info.pos.map((v) => fixed(v, 3)).join(', ')} mono />
    </PropertyField>
    <PropertyField label="B-factor">
      <Value text={fixed(info.bfac, 2)} mono />
    </PropertyField>
    <PropertyField label="Occupancy">
      <Value text={fixed(info.occ, 2)} mono />
    </PropertyField>
    <PropertyField label="Atom ID">
      <Value text={String(info.id)} mono />
    </PropertyField>
  </FlatSection>
)

/** Header name of a part: `A`, `A.49 ALA`, `A.49 ALA CA`. */
function headerName(info: MolStructInfo): string {
  if (info.kind === 'chain') return info.name
  if (info.kind === 'resid') return `${info.chain}.${info.index} ${info.name}`
  return `${info.chain}.${info.residueIndex} ${info.residueName} ${info.name}`
}

export const MolStructInspector: React.FC<MolStructInspectorProps> = ({
  cm,
  sceneId,
  molId,
  part,
  onGone,
  onHeaderChange,
}) => {
  // The part is a fresh object per target; key the fetch on its contents.
  const partKey = JSON.stringify(part)
  const fetchPage = useCallback(async (): Promise<PageState> => {
    const res = await cm.invokeService('getMolStructInfo', { sceneId, molId, target: JSON.parse(partKey) })
    if (!res.ok) return { info: null, gone: res.code === 'not-found' }
    return { info: res.info, gone: false }
  }, [cm, sceneId, molId, partKey])

  const { state } = useLiveFetch<PageState>({
    cm,
    initial: EMPTY,
    fallback: EMPTY,
    fetch: fetchPage,
    fetchDeps: [fetchPage],
    listeners: [
      // Coordinate edits, renames, deletions and their undo / redo.
      { enabled: true, srcMask: SEM_OBJECT, evtMask: SEM_ANY, scopeId: sceneId, debounceMs: EVENT_BURST_DEBOUNCE_MS },
    ],
  })
  const { info, gone } = state

  useEffect(() => {
    if (gone) onGone()
  }, [gone, onGone])

  useEffect(() => {
    if (info) onHeaderChange(headerName(info), '')
  }, [info, onHeaderChange])

  if (!info) return null
  return (
    <div className="inspector-body">
      <div className="insp-properties-tab">
        {info.kind === 'chain' && <ChainFields info={info} />}
        {info.kind === 'resid' && <ResidueFields info={info} />}
        {info.kind === 'atom' && <AtomFields info={info} />}
      </div>
    </div>
  )
}
