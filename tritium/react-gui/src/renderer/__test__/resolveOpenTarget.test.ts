/**
 * @file __test__/resolveOpenTarget.test.ts
 * @description The one scene resolver behind File > Open, drop, shell open
 * and `ensureActiveScene` (CLI, MCP, agent, Get PDB), while a non-molview tab
 * (Settings) is in front:
 *   - 'active' previews and commits into the molview last in front, switches
 *     to it only on commit, and returns only after the worker has activated
 *     it -- or rejects when that fails, so a caller never waits forever.
 *   - 'new' keeps its reuse rule to the molview in front: a background
 *     untouched scene is not reused.
 */

import { describe, it, expect, vi } from 'vitest'
import { makeResolveOpenTarget } from '@renderer/hooks/useEnsureActiveScene'
import type { OpenTargetDeps } from '@renderer/hooks/useEnsureActiveScene'

const BACK = { scene_uid: 7, view_id: 8 }

function deps(over: Partial<OpenTargetDeps> = {}): OpenTargetDeps {
  return {
    getActiveSceneInfo: () => undefined,
    resolveMolView: () => BACK,
    activateMolView: vi.fn(() => Promise.resolve()),
    newScene: vi.fn(() => Promise.resolve(null)),
    isSceneJustCreated: vi.fn(() => Promise.resolve(true)),
    ...over,
  }
}

describe('makeResolveOpenTarget with Settings in front', () => {
  it("'active' targets the last molview, switching only on commit and returning after activation", async () => {
    let release: () => void = () => {}
    const order: string[] = []
    const activateMolView = vi.fn(() => {
      order.push('activate')
      return new Promise<void>((r) => { release = () => { order.push('activated'); r() } })
    })
    const d = deps({ activateMolView })
    const plan = await makeResolveOpenTarget(d)('active')
    expect(plan.previewSceneId).toBe(BACK.scene_uid)
    expect(activateMolView).not.toHaveBeenCalled()

    const committed = plan.commit().then((t) => { order.push('returned'); return t })
    await Promise.resolve()
    release()
    expect(await committed).toEqual(BACK)
    expect(order).toEqual(['activate', 'activated', 'returned'])
    expect(activateMolView).toHaveBeenCalledWith(BACK.view_id)
    expect(d.newScene).not.toHaveBeenCalled()
  })

  it("'active' commit rejects when the activation fails", async () => {
    const d = deps({ activateMolView: () => Promise.reject(new Error('activateView failed')) })
    const plan = await makeResolveOpenTarget(d)('active')
    await expect(plan.commit()).rejects.toThrow('activateView failed')
  })

  it("'new' does not reuse an untouched scene in the background", async () => {
    const d = deps()
    const plan = await makeResolveOpenTarget(d)('new')
    expect(plan.previewSceneId).toBe(0)
    expect(d.isSceneJustCreated).not.toHaveBeenCalled()
  })
})
