/**
 * @file data/sceneQualityPresets.ts
 * @description Preset ladders for the Scene inspector's live-view AO /
 * post-AA sections, in the shape of the umbreon render-quality axes
 * (`RenderQualityAxis`): each axis is one dropdown whose step is DERIVED from
 * the live property values (never stored) and whose selection applies its
 * patch as one undo step.
 *
 * Contracts (mirroring renderSettings.ts / renderBackends.ts):
 * - Every step of an axis writes the same keys.
 * - The default step's patch must exactly match the C++ property defaults
 *   (Scene.qif), so a fresh scene reads as that step and not as Custom.
 * - The AO axis tunes Fast GI (Scene aoMethod "fastgi", the default; the
 *   visibility bitmask AO with baked probes): the probes carry the large
 *   cavities, so the screen-space
 *   reach (aoRadius) and the samples per side (aoSteps) trade contact detail
 *   and grain for cost (slices*steps, linear). aoSlices is deliberately
 *   absent: once the view is still each temporal-jitter sample computes 2
 *   slices anyway, and the accumulation averages them. aoIntensity is GTAO
 *   only and left alone.
 * - Every step keeps aoHalfRes on (half-res while the camera moves, and
 *   while zoomed in; full res when still otherwise; always full res for
 *   off-screen export).
 * - GTAO (Scene aoMethod "gtao") keeps its own ladder, the former one: there
 *   aoIntensity falls as aoRadius grows to keep large radii from crushing the
 *   image to black, and its default step is the former C++ defaults, which
 *   a scene file saved before Fast GI loads with (Scene::readFrom2).
 */
import { RENDER_QUALITY_CUSTOM } from "./renderSettings";
import type { RenderQualityAxis } from "./renderSettings";

/** AO look preset of Fast GI (aoMethod "fastgi"): reach + sampling. */
export const SCENE_AO_PRESET_AXIS: RenderQualityAxis = {
  key: "sceneAoPreset",
  label: "Preset",
  defaultStep: "medium",
  steps: [
    { id: "low", label: "Low", patch: { aoRadius: 6, aoSteps: 4, aoHalfRes: true } },
    // = C++ defaults (Scene.qif)
    { id: "medium", label: "Medium", patch: { aoRadius: 10, aoSteps: 8, aoHalfRes: true } },
    { id: "high", label: "High", patch: { aoRadius: 14, aoSteps: 12, aoHalfRes: true } },
  ],
};

/** AO look preset of GTAO (aoMethod "gtao"): reach + sampling + darkness compensation. */
export const SCENE_GTAO_PRESET_AXIS: RenderQualityAxis = {
  key: "sceneGtaoPreset",
  label: "Preset",
  defaultStep: "low",
  steps: [
    // = the former C++ defaults (a pre-Fast GI scene file loads with them)
    { id: "low", label: "Low", patch: { aoRadius: 4, aoSteps: 3, aoIntensity: 2.2, aoHalfRes: false } },
    { id: "medium", label: "Medium", patch: { aoRadius: 8, aoSteps: 4, aoIntensity: 1.9, aoHalfRes: true } },
    { id: "high", label: "High", patch: { aoRadius: 12, aoSteps: 5, aoIntensity: 1.7, aoHalfRes: true } },
  ],
};

/** The Scene aoMethod values (C++ enumdef), with their dropdown labels. */
export const SCENE_AO_METHODS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "fastgi", label: "Fast GI" },
  { id: "gtao", label: "GTAO" },
];

/**
 * The preset ladder of an AO method.
 *
 * @param method - Scene aoMethod value; anything but "gtao" is Fast GI
 * @returns the method's ladder
 */
export function aoPresetAxisFor(method: unknown): RenderQualityAxis {
  return method === "gtao" ? SCENE_GTAO_PRESET_AXIS : SCENE_AO_PRESET_AXIS;
}

/**
 * AA quality: spatial method plus temporal jitter supersampling. Jitter only
 * accumulates while the camera is still (idle-driven), so High/Ultra cost
 * convergence time after the view settles, not interactivity. Picking SMAA in
 * the Method row reads as Custom here (a tuning choice outside the ladder).
 */
export const SCENE_AA_QUALITY_AXIS: RenderQualityAxis = {
  key: "sceneAaQuality",
  label: "Quality",
  defaultStep: "standard",
  steps: [
    { id: "off", label: "Off", patch: { aa_method: "none", aaJitterLevel: 0 } },
    // = C++ defaults (Scene.qif)
    { id: "standard", label: "Standard (FXAA)", patch: { aa_method: "fxaa", aaJitterLevel: 0 } },
    { id: "high", label: "High (FXAA + 8x SS)", patch: { aa_method: "fxaa", aaJitterLevel: 3 } },
    { id: "ultra", label: "Ultra (FXAA + 32x SS)", patch: { aa_method: "fxaa", aaJitterLevel: 5 } },
  ],
};

/**
 * `stepOf` variant with epsilon comparison for numbers. The AO patch holds
 * reals (aoRadius) whose C++ double -> JSON -> JS number round trip must not
 * break the strict === used by renderSettings.stepOf.
 */
export function sceneStepOf(
  axis: RenderQualityAxis,
  read: (key: string) => string | number | boolean | undefined,
): string {
  const eq = (a: unknown, b: unknown) =>
    typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b;
  for (const step of axis.steps) {
    if (Object.entries(step.patch).every(([key, value]) => eq(read(key), value))) {
      return step.id;
    }
  }
  return RENDER_QUALITY_CUSTOM;
}
