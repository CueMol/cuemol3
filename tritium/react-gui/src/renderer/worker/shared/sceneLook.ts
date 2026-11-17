/**
 * @file worker/shared/sceneLook.ts
 * @description The look of a scene: CueMol3 or CueMol2 (legacy).
 *
 * A scene has the CueMol3 look when its style sets include `cuemol3_look`
 * (`data/cuemol3_look.xml`, the overrides of default_style.xml that make the
 * CueMol3 appearance). The look is not stored anywhere else: a qsc carries it
 * as that set (a `%%CONFDIR%%` reference, or its embedded contents), and a
 * scene made by CueMol2 has none, so it keeps the CueMol2 look. The look also
 * decides a newly loaded molecule's default paint.
 */

export type SceneLook = 'cuemol3' | 'cuemol2'

/** The look a new scene gets unless the user chose otherwise. */
export const DEFAULT_SCENE_LOOK: SceneLook = 'cuemol3'

/** Name (id) of the style set that gives a scene the CueMol3 look. */
export const CUEMOL3_LOOK_SET = 'cuemol3_look'

/** The look's style file, relative to the config (sysconfig) directory. */
export const CUEMOL3_LOOK_SRC = '%%CONFDIR%%/data/cuemol3_look.xml'

/** Whether `v` is a valid look id. */
export function isSceneLook(v: unknown): v is SceneLook {
  return v === 'cuemol3' || v === 'cuemol2'
}
