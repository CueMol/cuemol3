/**
 * @file worker/server/services/scene/sceneLook.test.ts
 * @description Switching a scene's look is one undo step that adds or removes
 * the `cuemol3_look` style set: added at the lowest priority (appended,
 * read-only) from its %%CONFDIR%% path, removed by name whatever its origin
 * (an embedded copy included). A switch to the look the scene already has
 * records nothing.
 */

import { describe, it, expect, vi } from 'vitest'
import { fakeScene, makeWorkerCtx } from '@renderer/worker/testing'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import { setSceneLook } from './sceneLook'

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))
vi.mock('@cuemol/core/src/BaseWrapper', () => ({ BaseWrapper: class {} }))

/** A scene whose look set has uid `lookUid` (0: none). */
function makeCtx(lookUid: number) {
  const scene = fakeScene({ uid: 100 })
  const styleMgr = {
    hasStyleSet: vi.fn((name: string) => (name === 'cuemol3_look' ? lookUid : 0)),
    loadStyleSetFromFileAt: vi.fn(() => 55),
    destroyStyleSet: vi.fn(() => true),
    firePendingEvents: vi.fn(),
  }
  const { ctx } = makeWorkerCtx({ scenes: [scene], extra: { styleMgr } })
  return { ctx: ctx as unknown as WorkerContext, scene, styleMgr }
}

describe('setSceneLook', () => {
  it('adds or removes the look set in one undo step', () => {
    const on = makeCtx(0)
    expect(setSceneLook(on.ctx, { sceneId: 100, look: 'cuemol3' })).toMatchObject({ ok: true })
    expect(on.styleMgr.loadStyleSetFromFileAt).toHaveBeenCalledWith(
      100, '%%CONFDIR%%/data/cuemol3_look.xml', true, true,
    )
    expect(on.scene.undo.committed).toEqual(['Change scene look'])

    const off = makeCtx(42)
    expect(setSceneLook(off.ctx, { sceneId: 100, look: 'cuemol2' })).toMatchObject({ ok: true })
    expect(off.styleMgr.destroyStyleSet).toHaveBeenCalledWith(100, 42)
    expect(off.scene.undo.committed).toEqual(['Change scene look'])
  })

  it('records nothing when the scene already has the look', () => {
    const same = makeCtx(42)
    expect(setSceneLook(same.ctx, { sceneId: 100, look: 'cuemol3' })).toMatchObject({ ok: true })
    expect(same.styleMgr.loadStyleSetFromFileAt).not.toHaveBeenCalled()
    expect(same.scene.undo.started).toEqual([])
  })
})
