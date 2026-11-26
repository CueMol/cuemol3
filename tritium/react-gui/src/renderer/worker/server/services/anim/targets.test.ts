/**
 * @file worker/server/services/anim/targets.test.ts
 * @description An element's target name is checked the way playback resolves
 * it, so whatever can play is accepted (a renderer group included) and a typo
 * is refused instead of silently playing nothing.
 */

import { describe, it, expect } from 'vitest'
import type { Scene } from '@cuemol/core/src/wrappers/Scene'
import { findMissingTarget } from './targets'

/** A scene as the name lookups see it: objects by name, each with its renderers (groups too). */
function sceneOf(objs: Record<string, { className: string; rends: string[] }>, cameras: string[]): Scene {
  const objOf = (name: string) => {
    const o = objs[name]
    if (!o) return null
    return { getClassName: () => o.className, getRendererByName: (r: string) => (o.rends.includes(r) ? {} : null) }
  }
  return {
    getObjectByName: objOf,
    getRendByName: (r: string) => (Object.values(objs).some((o) => o.rends.includes(r)) ? {} : null),
    hasCamera: (c: string) => cameras.includes(c),
  } as unknown as Scene
}

describe('findMissingTarget', () => {
  it('resolves names as playback does and names the first one that does not', () => {
    // `defaultpym_1` is a renderer group: playback finds it by name, so must the check.
    const scene = sceneOf(
      { '3ug9': { className: 'MolCoord', rends: ['defaultpym_1', 'cartoon1'] }, morph: { className: 'MorphMol', rends: [] } },
      ['front'],
    )
    expect(findMissingTarget(scene, 'rend', '3ug9/defaultpym_1')).toBeNull()
    expect(findMissingTarget(scene, 'rend', 'cartoon1, 3ug9/cartoon1')).toBeNull()
    expect(findMissingTarget(scene, 'rend', '3ug9/cartoon1, 3ug9/nope')).toBe('No renderer "3ug9/nope".')
    expect(findMissingTarget(scene, 'rend', 'other/cartoon1')).toBe('No renderer "other/cartoon1".')
    expect(findMissingTarget(scene, 'endcam', 'front')).toBeNull()
    expect(findMissingTarget(scene, 'endcam', 'back')).toMatch(/^No camera "back"/)
    expect(findMissingTarget(scene, 'mol', 'morph')).toBeNull()
    expect(findMissingTarget(scene, 'mol', '3ug9')).toMatch(/not a MorphMol/)
    // Empty is "none", which the inspector can set too.
    expect(findMissingTarget(scene, 'rend', '')).toBeNull()
  })
})
