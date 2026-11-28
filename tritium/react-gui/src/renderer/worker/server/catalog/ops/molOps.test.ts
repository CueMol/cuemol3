/**
 * @file worker/server/catalog/ops/molOps.test.ts
 * @description superpose: a success carries what the fit achieved (RMSD and
 * the rest, printed as one line), and a failure stays a failure -- the CLI
 * and MCP read `ok`, so a failed fit must not reach them as a success.
 */

import { describe, it, expect, vi } from 'vitest'

const { superposeMol } = vi.hoisted(() => ({ superposeMol: vi.fn() }))
vi.mock('@renderer/worker/server/services/molops/superposeMol', () => ({ superposeMol }))

import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'
import type { OpContext } from '../op'
import { superpose } from './molOps'

const oc = { sceneId: 1, viewId: 2, callId: 'c', markMutated: vi.fn() } as unknown as OpContext
const args = { movId: 2, refId: 1, movSel: null, refSel: null, algo: null, pivot: null, keepAsProperty: null, recenter: null }

describe('superpose', () => {
  it('returns the fit on success and the reason on failure', async () => {
    superposeMol.mockReturnValueOnce({
      ok: true,
      stats: { algo: 'USalign', rmsd: 0.912, nalgn: 46, rotation: 82.3, tm_ref: 0.893, tm_mov: 0.8931, seqid: 1 },
    })
    const done = await superpose.run({} as WorkerContext, args, oc)
    expect(done.ok && superpose.format?.(done.data)).toEqual([
      'USalign: RMSD 0.91 A over 46 residues, TM-score 0.893 (ref) / 0.893 (mov), seq id 100%, rotated 82.3 deg',
    ])

    // e.g. LSQ with selections of different sizes: C++ throws, the service reports it.
    superposeMol.mockReturnValueOnce({ ok: false, error: 'Reference mol(ref) nsel (327) != Fitting mol(af2) nsel (46)' })
    const failed = await superpose.run({} as WorkerContext, args, oc)
    expect(failed).toEqual({ ok: false, error: 'Reference mol(ref) nsel (327) != Fitting mol(af2) nsel (46)' })
  })
})
