/**
 * @file worker/server/services/anim/targets.ts
 * @description What an element can be pointed at.
 *
 * The inspector offers the scene's renderers, cameras and molecules as
 * choices; this reads them out of the live scene each time it is asked, so a
 * list cannot go stale behind an open inspector.
 */
import type { AnimObj } from "@cuemol/core/src/wrappers/AnimObj";
import type { Scene } from "@cuemol/core/src/wrappers/Scene";
import type { WorkerContext } from "@renderer/worker/server/types/WorkerContext";
import type { AnimElementType } from "@renderer/worker/shared/animTypes";
import { fail } from "@renderer/worker/shared/result";
import { getSceneOrNull } from "@renderer/worker/server/services/helpers/sceneResolver";
import type {
  AnimCameraOption,
  AnimMolOption,
  AnimRendererOption,
  GetAnimTargetOptionsArgs,
  GetAnimTargetOptionsResult,
} from "./types";
import { parseSceneTreeJSON, type SceneTreeNode } from "@renderer/worker/shared/sceneTreeTypes";
// --- detail shapes ---

/** Recurse renderer groups, collecting leaf renderers under `objName`. */
function collectRenderers(
  node: SceneTreeNode,
  objName: string,
  out: AnimRendererOption[],
): void {
  for (const child of node.children ?? []) {
    if (child.type === "renderer") {
      if (child.name) out.push({ name: child.name, objName, type: child.className ?? "" });
    } else if (child.type === "rendGroup") {
      collectRenderers(child, objName, out);
    }
  }
}

/** List renderer / camera / mol names for the target-picker dropdowns. */
export function getAnimTargetOptions(
  ctx: WorkerContext,
  args: GetAnimTargetOptionsArgs,
): GetAnimTargetOptionsResult {
  const empty: GetAnimTargetOptionsResult = fail("scene not found", "not-found");
  const scene = getSceneOrNull(ctx, args.sceneId);
  if (!scene) return empty;

  const renderers: AnimRendererOption[] = [];
  const mols: AnimMolOption[] = [];
  let tree: SceneTreeNode | null = null;
  try {
    tree = parseSceneTreeJSON(scene.getSceneDataJSON());
  } catch {
    tree = null;
  }
  if (tree) {
    for (const objNode of tree.children ?? []) {
      if (objNode.type !== "object") continue;
      if (objNode.className === "MorphMol") mols.push({ name: objNode.name });
      collectRenderers(objNode, objNode.name, renderers);
    }
  }

  const cameras: AnimCameraOption[] = [];
  try {
    const arr = JSON.parse(scene.getCameraInfoJSON()) as Array<{ name?: string }>;
    for (const c of arr) {
      if (c?.name) cameras.push({ name: c.name });
    }
  } catch {
    /* no cameras */
  }

  return { ok: true, renderers, cameras, mols };
}

// --- target name checks ---

/** The element properties that name a scene target, resolved at playback. */
export type AnimTargetProp = "rend" | "endcam" | "mol";

function classNameOf(obj: unknown): string {
  try {
    return (obj as { getClassName?: () => string }).getClassName?.() ?? "";
  } catch {
    return "";
  }
}

/** The node a lookup returned, or null when it threw or found none. */
function found<T>(read: () => T | null | undefined): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/** The renderer one `obj/rend` or bare `rend` item names, as playback finds it. */
function findRenderer(scene: Scene, item: string): unknown {
  const slash = item.indexOf("/");
  if (slash < 0) return found(() => scene.getRendByName(item));
  const obj = found(() => scene.getObjectByName(item.slice(0, slash).trim()));
  if (!obj) return null;
  return found(() => obj.getRendererByName(item.slice(slash + 1).trim()));
}

/**
 * Why `value` names nothing in the scene for `prop`, or null when every name
 * resolves. Resolves names the way playback does, so whatever an element can
 * play is accepted:
 * - `rend`: comma separated, each `obj/rend` (`Object::getRendByName`) or a
 *   bare `rend` (`Scene::getRendByName`), as `RendPropAnim::fillRendArray`;
 *   a renderer group resolves too.
 * - `endcam`: a scene camera (`CamMotion` uses `Scene::getCamera`).
 * - `mol`: a MorphMol object (`MolAnim` uses `Scene::getObjectByName`).
 * An empty value is "none" and always passes.
 */
export function findMissingTarget(scene: Scene, prop: AnimTargetProp, value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (prop === "rend") {
    for (const item of v.split(",")) {
      const name = item.trim();
      if (name === "") continue;
      if (!findRenderer(scene, name)) return `No renderer "${name}".`;
    }
    return null;
  }
  if (prop === "endcam") {
    let has = false;
    try {
      has = scene.hasCamera(v);
    } catch {
      has = false;
    }
    return has ? null : `No camera "${v}". list_cameras shows them.`;
  }
  const obj = found(() => scene.getObjectByName(v));
  if (!obj) return `No object "${v}".`;
  if (classNameOf(obj) !== "MorphMol") return `"${v}" is not a MorphMol object; a mol animation needs one.`;
  return null;
}

/** The target property each element type reads, if it has one. */
const TARGET_PROP_OF: Partial<Record<AnimElementType, AnimTargetProp>> = {
  ShowHideAnim: "rend",
  SlideInOutAnim: "rend",
  RealPropAnim: "rend",
  RendXformAnim: "rend",
  CamMotion: "endcam",
  MolAnim: "mol",
};

/**
 * Why an existing element's target does not resolve, or null. For
 * `list_anims`: a scene saved with a renderer that has since been removed or
 * renamed plays nothing for that element, silently.
 */
export function elementTargetError(scene: Scene, obj: AnimObj, type: AnimElementType): string | null {
  const prop = TARGET_PROP_OF[type];
  if (prop === undefined) return null;
  let value = "";
  try {
    value = String((obj as unknown as Record<string, unknown>)[prop] ?? "");
  } catch {
    return null;
  }
  return findMissingTarget(scene, prop, value);
}
