/**
 * @file hooks/useEnsureActiveScene.ts
 * @description Resolve the scene and view a load (or any scene command) goes
 * to, creating a fresh scene plus view (a new tab) when there is none.
 *
 * UXP always kept an active view, so a load always had somewhere to go.
 * Tritium has no implicit scene: with no tab open, or after every molview tab
 * was closed, a load command would otherwise silently do nothing. Every
 * command that loads something -- File > Open, Get PDB, a plugin that brings
 * its own importer -- resolves its target through here first.
 *
 * One implementation, {@link makeResolveOpenTarget}, split into a preview and
 * a commit so the scene is created (and the tab switched) only once the
 * caller commits to loading: a cancelled dialog never leaves a stray empty
 * tab behind or changes what is on screen. {@link useEnsureActiveScene} is
 * its `'active'` target committed at once, for callers with no dialog (Get
 * PDB, the console, MCP, the agent). Those stay on `'active'`, so the `'new'`
 * reuse rule never sweeps them along.
 *
 * With a non-molview tab (Settings) in front, `'active'` falls back to the
 * molview most recently in front and brings it back before returning. Only
 * inputs that bypass the GUI get here that way -- the GUI's own load items are
 * disabled then (shared/guiGate.ts).
 */

import { useMemo } from 'react'
import type { ActiveSceneCommandDeps } from '@renderer/commands/commandTypes'
import type { OpenFileTarget } from '@renderer/data/openFileTarget'
import { useCueMol } from '@renderer/hooks/cuemol/useCueMol'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import { useWorkspaceDispatch } from '@renderer/state/workspace'
import { useNewSceneAction } from './useNewSceneAction'
import type { NewSceneAction } from './useNewSceneAction'

/** The ids a load needs: where the object goes, and which view shows it. */
export interface ActiveSceneTarget {
  scene_uid: number
  view_id: number
}

export type EnsureActiveScene = () => Promise<ActiveSceneTarget | undefined>

/**
 * Reports whether a scene is still untouched (no objects, no cameras, not
 * modified). Injected so the resolver stays free of the worker client.
 */
export type IsSceneJustCreated = (sceneId: number) => Promise<boolean>

/**
 * A resolved open target, split so the scene is created as late as possible.
 *
 * `previewSceneId` is what the file-open option dialog should preview names
 * against -- the active scene when the file is going there, and 0 ("no scene
 * yet") when a new one is still to be made. `commit` then makes or returns the
 * real scene, and is called only once the dialog has been confirmed, so a
 * cancel never leaves an empty tab behind.
 */
export interface OpenTargetPlan {
  previewSceneId: number
  commit: () => Promise<ActiveSceneTarget | undefined>
}

export type ResolveOpenTarget = (target: OpenFileTarget) => Promise<OpenTargetPlan>

/** What the resolver reads and does; injected so it stays testable. */
export interface OpenTargetDeps {
  /** The molview in front, if any. */
  getActiveSceneInfo: ActiveSceneCommandDeps
  /** The molview to fall back to when none is in front (does not switch). */
  resolveMolView: () => ActiveSceneTarget | undefined
  /** Bring a molview to the front; resolves once the worker has activated it. */
  activateMolView: (viewId: number) => Promise<void>
  newScene: NewSceneAction
  isSceneJustCreated: IsSceneJustCreated
}

/**
 * Build the open-target resolver over explicit dependencies.
 *
 * 'active' loads into the molview in front, or -- with a non-molview tab in
 * front -- into the one most recently in front, which commit brings back and
 * waits for; with no molview at all it makes a scene on commit. Preview and
 * commit use the target picked first. Only that fallback waits for the
 * worker: the front molview and a new scene behave as they always did.
 *
 * 'new' takes a scene of its own, except when the scene in front is still
 * untouched -- the launch tab, or one just made with New Tab -- which it loads
 * into instead, so an opened file never leaves an empty "Untitled" stranded
 * beside it. It looks at the front molview only, never at the fallback.
 */
export function makeResolveOpenTarget(deps: OpenTargetDeps): ResolveOpenTarget {
  const create = async (): Promise<ActiveSceneTarget | undefined> => {
    const created = await deps.newScene()
    if (!created) return undefined
    return { scene_uid: created.scene_uid, view_id: created.view_uid }
  }

  return async (target: OpenFileTarget): Promise<OpenTargetPlan> => {
    const info = deps.getActiveSceneInfo()
    if (target === 'active') {
      if (info) return { previewSceneId: info.scene_uid, commit: async () => info }
      const back = deps.resolveMolView()
      if (!back) return { previewSceneId: 0, commit: create }
      return {
        previewSceneId: back.scene_uid,
        commit: async () => {
          await deps.activateMolView(back.view_id)
          return back
        },
      }
    }
    // 'new': reuse an untouched front scene rather than stranding it.
    if (info && (await deps.isSceneJustCreated(info.scene_uid))) {
      return { previewSceneId: info.scene_uid, commit: async () => info }
    }
    return { previewSceneId: 0, commit: create }
  }
}

/** The worker query behind `'new'`'s reuse rule; false while CueMol is not up. */
export function makeIsSceneJustCreated(cm: AsyncCueMol | null): IsSceneJustCreated {
  return async (sceneId) => {
    if (!cm) return false
    const res = await cm.invokeService('isSceneJustCreated', { sceneId })
    return res?.justCreated === true
  }
}

/** The open-target resolver over the live providers. */
export function useResolveOpenTarget(): ResolveOpenTarget {
  const { cm } = useCueMol()
  const { getActiveSceneInfo, resolveMolView, activateMolView } = useWorkspaceDispatch()
  const newScene = useNewSceneAction({ cm })

  return useMemo(
    () => makeResolveOpenTarget({
      getActiveSceneInfo,
      resolveMolView,
      activateMolView,
      newScene,
      isSceneJustCreated: makeIsSceneJustCreated(cm),
    }),
    [cm, getActiveSceneInfo, resolveMolView, activateMolView, newScene],
  )
}

/**
 * The `'active'` target committed at once, for callers with no option dialog.
 * Rejects when bringing the fallback molview back fails.
 */
export function useEnsureActiveScene(): EnsureActiveScene {
  const resolveOpenTarget = useResolveOpenTarget()
  return useMemo(
    () => async () => (await resolveOpenTarget('active')).commit(),
    [resolveOpenTarget],
  )
}
