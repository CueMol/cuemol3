/**
 * @file features/inspector/rows/SceneLookRow.tsx
 * @description The Scene page's "Legacy mode" switch: on gives the scene the
 * CueMol2 look (and default paint), off the CueMol3 one.
 *
 * A block rather than a row because no scene property backs it: the look is
 * whether the scene has the `cuemol3_look` style set (see
 * `worker/shared/sceneLook`). It reads the look from the worker and refetches
 * on the scene's style events, so an undo of the switch shows up here too.
 */

import React from 'react'
import { PropertyField, SwitchField } from '@renderer/h3-kit/form'
import { useCueMol } from '@renderer/hooks/cuemol/useCueMol'
import { useLiveFetch } from '@renderer/hooks/cuemol/useLiveFetch'
import { useLatestRef } from '@renderer/hooks/react/useLatestRef'
import { SEM_ANY, SEM_CHANGED, SEM_SCENE, SEM_STYLE } from '@renderer/event'
import { EVENT_BURST_DEBOUNCE_MS } from '@renderer/utils/timing'
import type { SceneLook } from '@renderer/worker/shared/sceneLook'
import type { CustomRowProps } from '@renderer/features/inspector/schema/types'

export const SceneLookRow: React.FC<CustomRowProps> = ({ ctx, disabled }) => {
  const { cm } = useCueMol()
  const sceneId = ctx.sceneId
  const sceneIdRef = useLatestRef(sceneId)
  const { state: look, refetch } = useLiveFetch<SceneLook | null>({
    cm,
    initial: null,
    fallback: null,
    fetch: () => {
      const sid = sceneIdRef.current
      if (!cm || sid === undefined) return null
      return cm.invokeService('getSceneLook', { sceneId: sid }).then((r) => (r.ok ? r.look : null))
    },
    onError: (err) => console.warn('getSceneLook failed:', err),
    fetchDeps: [sceneId],
    listeners: [
      {
        enabled: sceneId !== undefined,
        srcMask: SEM_STYLE,
        evtMask: SEM_ANY,
        scopeId: sceneId ?? -1,
        debounceMs: EVENT_BURST_DEBOUNCE_MS,
      },
      // A loaded or cleared scene replaces its style sets.
      {
        enabled: sceneId !== undefined,
        srcMask: SEM_SCENE,
        evtMask: SEM_CHANGED,
        scopeId: sceneId ?? -1,
        debounceMs: EVENT_BURST_DEBOUNCE_MS,
      },
    ],
  })

  if (sceneId === undefined) return null

  const apply = (legacy: boolean): void => {
    const next: SceneLook = legacy ? 'cuemol2' : 'cuemol3'
    if (!cm || next === look) return
    void cm
      .invokeService('setSceneLook', { sceneId, look: next })
      .then((r) => {
        if (!r.ok) console.warn('setSceneLook failed:', r.error)
      })
      .finally(refetch)
  }

  return (
    <PropertyField label="Legacy mode (CueMol2 look)" inline>
      <SwitchField
        checked={look === 'cuemol2'}
        disabled={disabled || look === null}
        onChange={apply}
      />
    </PropertyField>
  )
}
