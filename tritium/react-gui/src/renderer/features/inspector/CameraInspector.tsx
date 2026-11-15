/**
 * @file features/inspector/CameraInspector.tsx
 * @description The inspector page of one named camera (opened from the Camera
 * pane's Property button or context menu).
 *
 * Three sections:
 *
 * - Camera: the name (renamed through `CameraRename`, so the Camera pane and
 *   the inspector both follow) and where it lives -- embedded in the scene, or
 *   linked to a camera file (with Reload / Save).
 * - View: the stored viewpoint, read-only. A camera's view is changed by
 *   moving the 3D view and saving it (Save from view), not by typing numbers.
 * - Visibility: which objects / renderers the camera shows or hides when
 *   applied with show/hide. Each change is written at once as one undo step
 *   (`setCameraVisFlags`); this replaces the old modal dialog.
 *
 * `__current` (the live view point) shows only the Camera section, read-only,
 * with Save As: its values are refreshed right before something reads them, so
 * showing them would look stale, and it holds no visibility flags.
 *
 * Cameras have no uid, so the page is keyed by name. It refetches on camera
 * events (including visibility-flag edits and their undo) and on object /
 * renderer events (the Visibility list mirrors the scene's nodes).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@blueprintjs/core'
import { AppIcon } from '@renderer/h3-kit/primitives'
import { ButtonRow, CheckboxField, FormButton, PropertyField, TextField } from '@renderer/h3-kit/form'
import { FlatSection } from './AccordionSection'
import type { AsyncCueMol } from '@renderer/worker/client/AsyncCueMol'
import type { CameraDetail } from '@renderer/worker/shared/cameraTypes'
import type { VisFlagEntry } from '@renderer/worker/server/services/camera/cameraVisFlags'
import { useLiveFetch } from '@renderer/hooks/cuemol/useLiveFetch'
import { useCommands } from '@renderer/commands/CommandRegistry'
import { CmdId } from '@renderer/commands/ids'
import { SEM_ANY, SEM_CAMERA, SEM_OBJECT, SEM_RENDERER } from '@renderer/event'
import { EVENT_BURST_DEBOUNCE_MS } from '@renderer/utils/timing'

export interface CameraInspectorProps {
  cm: AsyncCueMol
  sceneId: number
  name: string
  /**
   * Scroll to the Visibility section once loaded (Edit vis flags). A new
   * request object asks again, even for the same camera.
   */
  focusRequest: object | null
  /** The camera is gone (deleted, scene closed): drop the target. */
  onGone: () => void
  /** Report the header name and type label. */
  onHeaderChange: (name: string, type: string) => void
}

interface PageState {
  detail: CameraDetail | null
  entries: VisFlagEntry[]
  /** The camera no longer exists. */
  gone: boolean
}

const EMPTY: PageState = { detail: null, entries: [], gone: false }

const fmt = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '-')

/**
 * Header type label: where the camera lives. None for `__current`, whose page
 * title already says what it is (and the label would crowd the name out).
 */
function sourceKind(d: CameraDetail): string {
  if (d.isCurrent) return ''
  return d.src !== '' ? 'file' : 'embedded'
}

/** One read-only value row. */
const ValueRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <PropertyField label={label}>
    <TextField value={value} onChange={() => undefined} readOnly mono={mono} />
  </PropertyField>
)

export const CameraInspector: React.FC<CameraInspectorProps> = ({
  cm,
  sceneId,
  name,
  focusRequest,
  onGone,
  onHeaderChange,
}) => {
  const { dispatch } = useCommands()

  const fetchPage = useCallback(async (): Promise<PageState> => {
    const res = await cm.invokeService('getCameraDetail', { sceneId, name })
    if (!res.ok) return { ...EMPTY, gone: res.code === 'not-found' }
    const detail = res.detail
    if (detail.isCurrent) return { detail, entries: [], gone: false }
    const vis = await cm.invokeService('getCameraVisFlags', {
      sceneId,
      cameraName: name,
    })
    return { detail, entries: vis.ok ? vis.entries : [], gone: false }
  }, [cm, sceneId, name])

  const listenerBase = {
    enabled: true,
    evtMask: SEM_ANY,
    scopeId: sceneId,
    debounceMs: EVENT_BURST_DEBOUNCE_MS,
  }
  const { state, refetch } = useLiveFetch<PageState>({
    cm,
    initial: EMPTY,
    fallback: EMPTY,
    fetch: fetchPage,
    fetchDeps: [fetchPage],
    listeners: [
      // Camera changes, renames, deletions and visibility-flag edits (and
      // their undo / redo).
      { ...listenerBase, srcMask: SEM_CAMERA },
      // The Visibility list is the scene's objects / renderers and their
      // current show / hide state.
      { ...listenerBase, srcMask: SEM_OBJECT | SEM_RENDERER },
    ],
  })
  const { detail, entries, gone } = state

  // A write to the visibility flags rebuilds the whole set from the rows it is
  // given, so the next one must start from the refetched rows: the section
  // stays disabled from the write until the refetch lands.
  const [busy, setBusy] = useState(false)
  const awaitingRefetch = useRef(false)
  useEffect(() => {
    if (!awaitingRefetch.current) return
    awaitingRefetch.current = false
    setBusy(false)
  }, [state])

  const writeVis = useCallback(
    async (next: VisFlagEntry[]) => {
      setBusy(true)
      try {
        await cm.invokeService('setCameraVisFlags', {
          sceneId,
          cameraName: name,
          entries: next,
        })
      } catch (err) {
        console.warn('setCameraVisFlags failed:', err)
      }
      awaitingRefetch.current = true
      refetch()
    },
    [cm, sceneId, name, refetch],
  )

  const clearVis = useCallback(async () => {
    setBusy(true)
    try {
      await cm.invokeService('clearCameraVisFlags', { sceneId, name })
    } catch (err) {
      console.warn('clearCameraVisFlags failed:', err)
    }
    awaitingRefetch.current = true
    refetch()
  }, [cm, sceneId, name, refetch])

  useEffect(() => {
    if (gone) onGone()
  }, [gone, onGone])

  useEffect(() => {
    if (detail) onHeaderChange(detail.name, sourceKind(detail))
  }, [detail, onHeaderChange])

  // Name draft: committed on blur / Enter through the rename command.
  const [draftName, setDraftName] = useState(name)
  useEffect(() => setDraftName(name), [name])
  const commitName = useCallback(() => {
    const next = draftName.trim()
    if (next === '' || next === name) {
      setDraftName(name)
      return
    }
    dispatch(CmdId.CameraRename, { oldName: name, newName: next })
      .then((ok) => {
        if (!ok) setDraftName(name)
      })
      .catch((err: unknown) => console.warn('rename camera failed:', err))
  }, [draftName, name, dispatch])

  const visRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!focusRequest || !detail) return
    visRef.current?.scrollIntoView({ block: 'start' })
  }, [focusRequest, detail])

  const run = useCallback((what: string, p: Promise<unknown>) => {
    p.catch((err: unknown) => console.warn(`${what} failed:`, err))
  }, [])

  if (!detail) {
    return <div className="inspector-empty">{gone ? 'The camera no longer exists.' : 'Loading...'}</div>
  }

  const linked = detail.src !== ''
  const sourceRow = (
    <PropertyField label="Source">
      <TextField value={linked ? detail.src : 'Embedded in the scene'} onChange={() => undefined} readOnly />
    </PropertyField>
  )

  const includedCount = entries.filter((e) => e.included).length
  const setRow = (i: number, patch: Partial<VisFlagEntry>): void => {
    void writeVis(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)))
  }

  return (
    <div className="inspector-body">
      <div className="insp-properties-tab">
        <FlatSection title="Camera">
          <PropertyField label="Name">
            {detail.isCurrent ? (
              <TextField value={name} onChange={() => undefined} readOnly />
            ) : (
              <TextField
                value={draftName}
                onChange={setDraftName}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') setDraftName(name)
                }}
              />
            )}
          </PropertyField>
          {sourceRow}
          {detail.isCurrent ? (
            <ButtonRow>
              <FormButton
                text="Save As..."
                onClick={() => run('save camera', dispatch(CmdId.CameraSaveAs, { name }))}
              />
            </ButtonRow>
          ) : (
            linked && (
              <ButtonRow>
                <FormButton
                  text="Reload"
                  onClick={() => run('reload camera', dispatch(CmdId.CameraReload, { name }))}
                />
                <FormButton text="Save" onClick={() => run('save camera', dispatch(CmdId.CameraSave, { name }))} />
              </ButtonRow>
            )
          )}
        </FlatSection>

        {!detail.isCurrent && (
          <>
            <FlatSection title="View">
              <ValueRow label="Center" value={detail.center.map((v) => fmt(v, 3)).join(', ')} mono />
              <ValueRow label="Rotation (x, y, z, a)" value={detail.rotation.map((v) => fmt(v, 4)).join(', ')} mono />
              <ValueRow label="Zoom" value={fmt(detail.zoom, 2)} />
              <ValueRow label="Distance" value={fmt(detail.distance, 2)} />
              <ValueRow label="Slab" value={fmt(detail.slab, 2)} />
              <ValueRow label="Projection" value={detail.perspective ? 'Perspective' : 'Orthographic'} />
              <ValueRow label="Center mark" value={detail.centerMark} />
            </FlatSection>

            <div ref={visRef}>
              <FlatSection title="Visibility">
                <ButtonRow className="camera-insp-vis-actions">
                  <span className="camera-insp-vis-count type-caption">
                    {includedCount} / {entries.length} included
                  </span>
                  <FormButton
                    text="Capture"
                    title="Include every object and renderer with its current show / hide state"
                    disabled={busy || entries.length === 0}
                    onClick={() =>
                      void writeVis(
                        entries.map((e) => ({
                          ...e,
                          included: true,
                          visible: e.currentVisible ?? e.visible,
                        })),
                      )
                    }
                  />
                  <FormButton text="Clear" disabled={busy || includedCount === 0} onClick={() => void clearVis()} />
                </ButtonRow>
                {entries.length === 0 ? (
                  <div className="h3-list-empty">(no objects)</div>
                ) : (
                  <div className="camera-insp-vis-list" role="table" aria-label="Visibility flags">
                    {entries.map((e, i) => {
                      const shown = e.included ? e.visible : (e.currentVisible ?? e.visible)
                      return (
                        <div
                          key={e.tgtId}
                          role="row"
                          className={`camera-insp-vis-row${e.included ? '' : ' is-excluded'}`}
                          style={{
                            paddingLeft: `calc(var(--list-row-pad-x) + var(--space-5) * ${e.depth ?? 0})`,
                          }}
                        >
                          <CheckboxField
                            checked={e.included}
                            disabled={busy}
                            ariaLabel={`Include ${e.tgtName}`}
                            onChange={(c) =>
                              setRow(i, {
                                included: c,
                                visible: e.currentVisible ?? e.visible,
                              })
                            }
                          />
                          <AppIcon name={e.isObj ? 'node.object' : 'node.renderer'} aria-hidden />
                          <span className="camera-insp-vis-name type-row">{e.tgtName}</span>
                          <Button
                            minimal
                            small
                            icon={<AppIcon name={shown ? 'ui.eyeOpen' : 'ui.eyeClosed'} aria-hidden />}
                            className="visibility-toggle"
                            aria-label={`${shown ? 'Shown' : 'Hidden'}: ${e.tgtName}`}
                            disabled={busy || !e.included}
                            onClick={() => setRow(i, { visible: !e.visible })}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </FlatSection>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
