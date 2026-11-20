/**
 * @file features/inspector/rows/AoMethodRow.tsx
 * @description The Scene's AO method dropdown (Scene `aoMethod`: fastgi /
 * gtao).
 *
 * A block rather than an enum row because switching the method also switches
 * the preset ladder: Fast GI and GTAO read the same radius / steps
 * properties very differently (GTAO needs its intensity lowered as the radius
 * grows), so a switch writes the method together with the new ladder's
 * Medium step, as one undo step. Leaving the old tuning in place would land
 * the new method on Custom with a look nobody chose.
 */

import React from 'react'
import { PropertyField, SelectField } from '@renderer/h3-kit/form'
import { stepPatch } from '@renderer/data/renderSettings'
import { SCENE_AO_METHODS, aoPresetAxisFor } from '@renderer/data/sceneQualityPresets'
import type { PropMultiWrite } from '@renderer/features/inspector/rendererPropSections'
import type { CustomRowProps } from '@renderer/features/inspector/schema/types'

/**
 * The AO method dropdown; renders nothing when the scene does not expose
 * `aoMethod`.
 */
export const AoMethodRow: React.FC<CustomRowProps> = ({ ctx, onSetMany, disabled }) => {
  const methodEntry = ctx.get('aoMethod')
  if (!methodEntry) return null
  const method = String(methodEntry.value)

  const apply = (next: string): void => {
    if (next === method || !onSetMany) return
    const axis = aoPresetAxisFor(next)
    const patch = stepPatch(axis, 'medium')
    const writes: PropMultiWrite[] = [{ key: 'aoMethod', valueType: methodEntry.type, value: next }]
    for (const [key, value] of Object.entries(patch)) {
      const entry = ctx.get(key)
      if (entry) writes.push({ key, valueType: entry.type, value })
    }
    onSetMany(writes)
  }

  return (
    <PropertyField label="Method">
      <SelectField value={method} disabled={disabled} onChange={apply}>
        {SCENE_AO_METHODS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </SelectField>
    </PropertyField>
  )
}
