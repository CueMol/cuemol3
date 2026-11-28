/**
 * @file worker/server/catalog/fileLoad.test.ts
 * @description A load op names its renderer the way the GUI does: scene-wide
 * unique, after the preset or type finally chosen; a given name is kept.
 */

import { describe, it, expect } from 'vitest'
import type { RendererOptions } from '@renderer/worker/shared/fileOpenTypes'
import { applyRendererArgs } from './fileLoad'

const taken = new Set(['cartoon1', 'ribbon1_1'])
const scene = { getRendByName: (n: string) => (taken.has(n) ? {} : null) }

function rend(r: Partial<RendererOptions>): RendererOptions {
  return { objectName: 'm', rendererType: 'cartoon', rendererName: 'cartoon1', selectionEnabled: false, selection: '*', centerView: true, mapCenterPolicy: 'auto', ...r }
}

describe('applyRendererArgs', () => {
  it('numbers an unnamed renderer scene-wide after the final preset or type, and keeps a given name', () => {
    const plain = rend({})
    applyRendererArgs(plain, {}, scene)
    expect(plain.rendererName).toBe('cartoon2')

    // The preset the user asked for, not the default one the options started with.
    const preset = rend({ presetName: 'Default1RendPreset', rendererName: 'default1_1' })
    applyRendererArgs(preset, { preset: 'Ribbon1RendPreset' }, scene)
    expect(preset.rendererName).toBe('ribbon1_2')

    const named = rend({})
    applyRendererArgs(named, { rendererName: 'modelA' }, scene)
    expect(named.rendererName).toBe('modelA')
  })
})
