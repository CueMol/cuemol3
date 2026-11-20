/**
 * @file features/inspector/schema/scene.ts
 * @description The Scene's pages (C++ `qsys::Scene`, node type "scene").
 *
 * The Scene has no dedicated UXP property dialog -- its rendering settings
 * were only editable through the generic property tree. These pages surface
 * the meaningful subset (the CueMol3 / CueMol2 look, ambient occlusion /
 * GTAO, post-process anti-aliasing, background colour, CMYK colour proofing).
 *
 * The AO and AA pages are deliberately preset-only: the individual tuning
 * knobs stay in the generic property tree, and a hand edit there reads back
 * into the dropdown as "Custom" rather than being duplicated as rows here.
 * The AO page also picks the AO method (Fast GI / GTAO), and its preset
 * ladder follows the method. Fast GI adds its two look knobs that no preset
 * covers: the indirect light and the baked cavity occlusion.
 *
 * Registered under the key "Scene", which is the typeLabel `getGenericProps`
 * reports for a scene node and therefore what `PropertiesTab` resolves the
 * pages by -- not the lowercase tree node type.
 */

import { eq, isOff } from './predicates'
import { AoMethodRow, qualityPresetRow } from '@renderer/features/inspector/rows'
import { SceneLookRow } from '@renderer/features/inspector/rows/SceneLookRow'
import { SCENE_AA_QUALITY_AXIS, aoPresetAxisFor } from '@renderer/data/sceneQualityPresets'
import type { SchemaSectionDef } from './types'
import type { PropMultiWrite } from '@renderer/features/inspector/rendererPropSections'

const ICC_INTENT_LABELS: Record<string, string> = {
  perceptual: 'Perceptual',
  relative_colorimetric: 'Relative colorimetric',
  saturation: 'Saturation',
  absolute_colorimetric: 'Absolute colorimetric',
}

/** Seeded when proofing is switched on with no profile named (UXP parity). */
const DEFAULT_ICC_PROFILE = 'GenericCMYK.icm'

export const SCENE_SECTIONS: SchemaSectionDef[] = [
  {
    key: 'scene-ao',
    title: 'Ambient occlusion',
    defaultExpanded: true,
    rows: [
      { kind: 'bool', key: 'aoEnabled', label: 'Enabled' },
      // Nothing to choose while the effect is off.
      { kind: 'custom', key: 'ao-method', disabledWhen: isOff('aoEnabled'), Component: AoMethodRow },
      {
        kind: 'custom',
        key: 'ao-preset',
        disabledWhen: isOff('aoEnabled'),
        Component: qualityPresetRow((ctx) => aoPresetAxisFor(ctx.value('aoMethod'))),
      },
      {
        kind: 'slider',
        key: 'aoBounce',
        label: 'Indirect light',
        min: 0,
        max: 2,
        step: 0.05,
        visibleWhen: eq('aoMethod', 'fastgi'),
        disabledWhen: isOff('aoEnabled'),
      },
      {
        kind: 'slider',
        key: 'aoProbeStrength',
        label: 'Baked occlusion',
        min: 0,
        max: 1,
        step: 0.05,
        visibleWhen: eq('aoMethod', 'fastgi'),
        disabledWhen: isOff('aoEnabled'),
      },
    ],
  },
  {
    // One overall knob: it scales every light alike, so the image gets
    // brighter or darker while the AO depth cue keeps its strength.
    key: 'scene-light',
    title: 'Lighting',
    defaultExpanded: true,
    rows: [
      { kind: 'slider', key: 'lightBrightness', label: 'Brightness', min: 0.5, max: 1.5, step: 0.05 },
    ],
  },
  {
    key: 'scene-aa',
    title: 'Anti-aliasing',
    defaultExpanded: false,
    // Anti-aliasing is independent of ambient occlusion, so it is never gated.
    rows: [
      { kind: 'custom', key: 'aa-preset', Component: qualityPresetRow(SCENE_AA_QUALITY_AXIS) },
    ],
  },
  {
    key: 'scene-bg',
    title: 'Background',
    defaultExpanded: false,
    rows: [{ kind: 'color', key: 'bgcolor', label: 'Color' }],
  },
  {
    key: 'scene-proof',
    title: 'Color proofing',
    defaultExpanded: false,
    rows: [
      {
        kind: 'bool',
        key: 'use_colproof',
        label: 'Enabled',
        // Proofing with no profile named does nothing, so switching it on
        // seeds a default CMYK one in the same undo step (UXP
        // `toggleSceneColorProofing`).
        commit: (ctx, on) => {
          const flag = ctx.get('use_colproof')!
          const writes: PropMultiWrite[] = [
            { key: flag.key, valueType: flag.type, value: on },
          ]
          const icc = ctx.get('icc_filename')
          if (on && icc && !String(icc.value)) {
            writes.push({ key: icc.key, valueType: icc.type, value: DEFAULT_ICC_PROFILE })
          }
          return writes
        },
      },
      { kind: 'text', key: 'icc_filename', label: 'Profile', placeholder: 'ICC profile' },
      { kind: 'mappedEnum', key: 'icc_intent', label: 'Intent', labels: ICC_INTENT_LABELS },
    ],
  },
  {
    // The look is not a property but the scene's `cuemol3_look` style set:
    // the row reads and switches it through its own worker services.
    key: 'scene-compat',
    title: 'Compatibility',
    defaultExpanded: true,
    rows: [{ kind: 'custom', key: 'scene-legacy-mode', Component: SceneLookRow }],
  },
]
