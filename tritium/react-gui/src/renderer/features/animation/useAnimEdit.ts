/**
 * @file features/animation/useAnimEdit.ts
 * @description Strip-editing actions for `AnimationPanel` (move / resize / add /
 * remove / reorder).
 *
 * Thin `invokeService` wrappers with no local state: each mutation fires a
 * SEM_ANIM event on the C++ side, and `useAnimTimeline` refetches the timeline
 * in response, so the panel stays in sync without returning the new data here.
 *
 * The one exception is `addElement`, which can seed the manager's start camera
 * (UXP parity, see `ensureStartCam` worker-side). That is a manager property
 * change with no event behind it, so the post-add snapshot is pushed to
 * `onMgrState` instead of being waited for. A paste can seed it the same way,
 * so the snapshot is read once it is done.
 *
 * Copy and paste go through the OS clipboard like the other panes' copy and
 * paste (`hooks/sceneTree/sceneClipIo.ts`): the worker serializes the element,
 * main owns the clipboard.
 */

import { useCallback, useRef } from "react";
import type { AsyncCueMol } from "@renderer/worker/client/AsyncCueMol";
import type { AnimAddType, AnimMgrState } from "@renderer/types";
import { readSceneClip, writeSceneClip } from "@renderer/hooks/sceneTree/sceneClipIo";

interface UseAnimEditOptions {
  cm: AsyncCueMol | null;
  sceneId: number | undefined;
  /** Active view; lets an add seed the `__current` start camera. */
  viewId: number | undefined;
  /** Receives the post-add manager snapshot (start-camera seeding). */
  onMgrState?: (mgr: AnimMgrState) => void;
  /** Called with the reason when the worker refuses an edit. */
  onError?: (message: string) => void;
}

export interface UseAnimEditResult {
  /** Add a new element; `insertIndex` inserts before it (append when omitted). */
  addElement: (type: AnimAddType, insertIndex?: number) => void;
  /** Remove the element `uid`. */
  removeElement: (uid: number) => void;
  /** Reorder `uid` to the raw target index (i-1 to move up, i+1 to move down). */
  moveElement: (uid: number, to: number) => void;
  /**
   * Set an element's RELATIVE start/end (ms). Resolves true once the worker
   * accepted the write, so a caller holding an optimistic preview knows whether
   * a refetch is actually coming.
   */
  setElementTime: (uid: number, startMs: number, endMs: number) => Promise<boolean>;
  /** Put the element `uid` on the clipboard. Resolves true once it is there. */
  copyElement: (uid: number) => Promise<boolean>;
  /**
   * Paste the clipboard's animation element before `insertIndex` (append when
   * omitted). Resolves the new element's uid, or null when nothing was pasted
   * (the clipboard holds something else, or the worker refused).
   */
  pasteElement: (insertIndex?: number) => Promise<number | null>;
}

/**
 * Editing actions for the active scene's animation timeline.
 *
 * @param opts - `cm` (worker client) and the active `sceneId`.
 * @returns add / remove / move / setElementTime callbacks (no-ops without a scene).
 */
export function useAnimEdit({
  cm,
  sceneId,
  viewId,
  onMgrState,
  onError,
}: UseAnimEditOptions): UseAnimEditResult {
  const cmRef = useRef(cm);
  cmRef.current = cm;
  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const onMgrStateRef = useRef(onMgrState);
  onMgrStateRef.current = onMgrState;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // A rejected promise is a contract violation (services return Fail), but
  // the user still deserves to hear that nothing happened.
  const failed = (what: string) => (e: unknown) => {
    console.warn(`${what} failed:`, e);
    onErrorRef.current?.(String(e));
  };

  const addElement = useCallback((type: AnimAddType, insertIndex?: number) => {
    const c = cmRef.current;
    const sid = sceneIdRef.current;
    if (!c || sid === undefined) return;
    c.invokeService("animAddElement", {
      sceneId: sid,
      type,
      insertIndex,
      viewId: viewIdRef.current,
    })
      .then((res) => {
        // The snapshot rides on a failure too: the start camera may have been
        // seeded before the add itself was refused.
        if (res.mgr) onMgrStateRef.current?.(res.mgr);
        if (!res.ok) onErrorRef.current?.(res.error);
      })
      .catch(failed("animAddElement"));
  }, []);

  const removeElement = useCallback((uid: number) => {
    const c = cmRef.current;
    const sid = sceneIdRef.current;
    if (!c || sid === undefined) return;
    c.invokeService("animRemoveElement", { sceneId: sid, uid })
      .then((res) => {
        if (!res.ok) onErrorRef.current?.(res.error);
      })
      .catch(failed("animRemoveElement"));
  }, []);

  const moveElement = useCallback((uid: number, to: number) => {
    const c = cmRef.current;
    const sid = sceneIdRef.current;
    if (!c || sid === undefined) return;
    c.invokeService("animMoveElement", { sceneId: sid, uid, to })
      .then((res) => {
        if (!res.ok) onErrorRef.current?.(res.error);
      })
      .catch(failed("animMoveElement"));
  }, []);

  const setElementTime = useCallback(
    (uid: number, startMs: number, endMs: number): Promise<boolean> => {
      const c = cmRef.current;
      const sid = sceneIdRef.current;
      if (!c || sid === undefined) return Promise.resolve(false);
      return c
        .invokeService("animSetElementTime", { sceneId: sid, uid, startMs, endMs })
        .then((res) => {
          if (!res.ok) onErrorRef.current?.(res.error);
          return res.ok;
        })
        .catch((e: unknown) => {
          failed("animSetElementTime")(e);
          return false;
        });
    },
    [],
  );

  const copyElement = useCallback((uid: number): Promise<boolean> => {
    const c = cmRef.current;
    const sid = sceneIdRef.current;
    if (!c || sid === undefined) return Promise.resolve(false);
    return c
      .invokeService("copyNode", { sceneId: sid, nodeId: uid, nodeType: "anim" })
      .then((res) => writeSceneClip(res))
      .catch((e: unknown) => {
        failed("copyNode")(e);
        return false;
      });
  }, []);

  const pasteElement = useCallback(async (insertIndex?: number): Promise<number | null> => {
    const c = cmRef.current;
    const sid = sceneIdRef.current;
    if (!c || sid === undefined) return null;
    const clip = await readSceneClip();
    if (!clip || clip.kind !== "anim") return null;
    try {
      const res = await c.invokeService("pasteNode", {
        sceneId: sid,
        ...clip,
        insertIndex,
        viewId: viewIdRef.current,
      });
      // The start camera may have been seeded (no event behind it).
      const mgr = await c.invokeService("animGetMgrState", { sceneId: sid });
      onMgrStateRef.current?.(mgr);
      if (!res.ok) {
        onErrorRef.current?.("The animation element could not be pasted.");
        return null;
      }
      return res.newId;
    } catch (e) {
      failed("pasteNode")(e);
      return null;
    }
  }, []);

  return { addElement, removeElement, moveElement, setElementTime, copyElement, pasteElement };
}
