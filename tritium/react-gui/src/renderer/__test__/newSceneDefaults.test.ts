/**
 * The New Scene defaults' two standing contracts.
 *
 *   1. The factory defaults give a new scene High AA and Medium AO; every
 *      other property stays at its C++ default (Scene.qif).
 *   2. A persisted preset id the axis no longer has falls back to the axis
 *      default, rather than reaching the worker as a name nothing expands
 *      (which would silently leave those properties at whatever they were).
 */

import { describe, it, expect } from 'vitest'
import {
  FACTORY_NEW_SCENE_DEFAULTS,
  sanitizeNewSceneDefaults,
  toInitialProps,
} from '@renderer/data/newSceneDefaults'

/** High AA, Medium AO; the rest are the C++ defaults from src/qsys/Scene.qif. */
const FACTORY_PROPS = {
  aa_method: 'fxaa',
  aaJitterLevel: 3,
  aoEnabled: true,
  aoRadius: 10,
  aoSteps: 8,
  aoHalfRes: true,
  bgcolor: '#000000',
  use_colproof: false,
}

describe('newSceneDefaults', () => {
  it('expands the factory defaults to High AA / Medium AO', () => {
    // The look is not a scene property: a new scene gets the CueMol3 look.
    expect(toInitialProps(FACTORY_NEW_SCENE_DEFAULTS)).toEqual({ ...FACTORY_PROPS, look: 'cuemol3' })
  })

  it('reads a stored preference back', () => {
    expect(
      sanitizeNewSceneDefaults({
        aaPreset: 'ultra',
        aoEnabled: true,
        aoPreset: 'high',
        bgcolor: '#ffffff',
        useColproof: true,
        look: 'cuemol2',
      }),
    ).toEqual({
      aaPreset: 'ultra',
      aoEnabled: true,
      aoPreset: 'high',
      bgcolor: '#ffffff',
      useColproof: true,
      look: 'cuemol2',
    })
  })

  it('falls back to the factory value for an unknown preset or look, or a missing field', () => {
    expect(sanitizeNewSceneDefaults({ aaPreset: 'gone', aoPreset: 'gone', look: 'gone' })).toEqual(
      FACTORY_NEW_SCENE_DEFAULTS,
    )
    expect(sanitizeNewSceneDefaults({})).toEqual(FACTORY_NEW_SCENE_DEFAULTS)
    expect(sanitizeNewSceneDefaults(undefined)).toEqual(FACTORY_NEW_SCENE_DEFAULTS)
  })

  it('expands a chosen preset into the properties behind it', () => {
    const props = toInitialProps({
      ...FACTORY_NEW_SCENE_DEFAULTS,
      aaPreset: 'off',
      aoEnabled: true,
      aoPreset: 'high',
    })
    expect(props.aa_method).toBe('none')
    expect(props.aoEnabled).toBe(true)
    expect(props.aoRadius).toBe(14)
  })
})
