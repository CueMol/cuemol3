/**
 * @file worker/server/catalog/ops/rendererOps.test.ts
 * @description set_renderer_coloring's `paintColor`: the main colour of a
 * paint-type-paint colouring maps onto the coloring id the Paint coloring
 * menu uses (CueMol2 / CueMol1 fixed colours, or one theme colour), and a
 * name that is no theme colour is refused rather than painted unresolved.
 */

import { describe, it, expect, vi } from 'vitest'

const { setRendererColoring } = vi.hoisted(() => ({
  setRendererColoring: vi.fn((..._a: unknown[]) => ({ ok: true })),
}))

vi.mock('@renderer/worker/server/services/coloring/applyColoring', () => ({
  setRendererColoring,
  setColoringProp: vi.fn(),
}))
vi.mock('@renderer/worker/server/services/helpers/defPaintColoring', () => ({
  PAINT_CHOICE_CUEMOL2: 'cuemol2',
  PAINT_CHOICE_CUEMOL1: 'cuemol1',
  listPaintThemes: () => [{ theme: 'okabeito', label: 'Okabe-Ito', colors: [{ name: 'okabeito_3', hex: '#009e73' }] }],
}))

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import type { OpContext } from '../op'
import { setRendererColoringOp } from './rendererOps'

const oc = { sceneId: 1, viewId: 2, callId: 'c', markMutated: vi.fn() } as unknown as OpContext

/** Run the op with mode paint-type-paint and `paintColor`; the coloring id it asked for, or null. */
async function paintWith(paintColor: string | null): Promise<string | null> {
  setRendererColoring.mockClear()
  const res = await setRendererColoringOp.run(
    {} as WorkerContext,
    { nodeId: 5, nodeType: 'object', mode: 'paint-type-paint', styleName: null, paintColor },
    oc,
  )
  if (!res.ok) return null
  return (setRendererColoring.mock.calls[0][1] as { coloringId: string }).coloringId
}

describe('set_renderer_coloring paintColor', () => {
  it('maps the main colour onto the Paint coloring menu ids', async () => {
    expect(await paintWith(null)).toBe('paint-type-paint')
    expect(await paintWith('cuemol2')).toBe('paint-type-paint-cuemol2')
    expect(await paintWith('cuemol1')).toBe('paint-type-paint-cuemol1')
    expect(await paintWith('okabeito_3')).toBe('paint-theme-okabeito_3')
    expect(await paintWith('nosuch_1')).toBeNull()
    expect(setRendererColoring).not.toHaveBeenCalled()
  })
})
