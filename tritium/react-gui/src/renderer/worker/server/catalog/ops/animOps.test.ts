/**
 * @file worker/server/catalog/ops/animOps.test.ts
 * @description How an animation command names an element: its number in
 * list_anims (from 1), #uid, or a name -- and a shared name is refused rather
 * than guessed.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AnimElement } from '@renderer/worker/shared/animTypes'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'

// The element as the inspector reads it: every type-specific value there is.
vi.mock('@renderer/worker/server/services/anim/detail', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAnimElementDetail: () => ({
    ok: true,
    detail: {
      common: { uid: 5, name: 'all', type: 'RockSpin', disabled: false, timeRefName: '', startMs: 0, endMs: 1000, quadric: 0 },
      typeProps: {
        angle: 30, axisX: 0, axisY: 1, axisZ: 0, pattern: 'rock', cycles: 1, phase: 0, aspect: 1, envelope: 'none',
        endcam: 'c', ignorerotate: false, ignorecenter: false, ignorezoom: false, ignoreslab: false,
        rend: 'r', hide: false, fade: false, tgtAlpha: 1, direction: 0, distance: 1, mol: 'm', startValue: 0, endValue: 1,
      },
      siblings: [],
    },
  }),
}))
vi.mock('@renderer/worker/server/services/anim/resolve', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSceneMgr: () => null,
}))

import { elementProps, findElement, SET_PROPS } from './animOps'

function el(uid: number, name: string): AnimElement {
  return {
    index: 0, uid, name, type: 'SimpleSpin', disabled: false, timeRefName: '',
    startMs: 0, endMs: 1000, absStartMs: 0, absEndMs: 1000, quadric: 0, timeRefState: 'ok',
  }
}

describe('findElement', () => {
  it('takes a number from 1, #uid or a unique name', () => {
    const list = [el(37, 'spin'), el(38, 'wait'), el(39, 'wait')]
    expect(findElement(list, '1')).toBe(list[0])
    expect(findElement(list, '#39')).toBe(list[2])
    expect(findElement(list, 'spin')).toBe(list[0])
    expect(findElement(list, 'wait')).toMatch(/2 animation elements are named "wait"/)
    expect(findElement(list, '4')).toMatch(/1 to 3/)
  })
})

describe('list_anim_props', () => {
  it('lists every value under a name set_anim_prop writes (times under set_anim_time)', () => {
    const listed = elementProps({} as WorkerContext, 1, 5)?.properties.map((p) => p.prop) ?? []
    expect(listed).toContain('axis')
    const writable = new Set<string>([...SET_PROPS, 'startMs', 'endMs'])
    expect(listed.filter((p) => !writable.has(p))).toEqual([])
  })
})
