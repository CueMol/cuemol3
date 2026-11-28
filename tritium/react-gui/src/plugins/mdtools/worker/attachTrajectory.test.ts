/**
 * Contract tests for attaching dropped trajectory files to a molecule
 * (attachTrajectory.ts).
 *
 * Pinned: a plain molecule is converted in ONE undo txn (XML round trip into
 * a Trajectory, objects swapped, scene-tree position kept, its structure file
 * appended as the frame-0 `structframe` block, then the trajectory files); a
 * molecule opened with a coordinate file takes that file as the frame-0 block
 * instead (topology read back without the sub-stream), and one without
 * coordinates gets no frame-0 block and the views fitted after the attach; a
 * failed read rolls all of it back; and the target list keeps only molecules
 * the files fit, with the reason for those that cannot be converted.
 *
 * The console / MCP arguments (add_traj_block): `replace` removes a
 * Trajectory's blocks before the new ones in the same txn, and a load
 * selection is applied to a converted molecule before its frame-0 block but
 * refused for a Trajectory (its dropped atoms cannot come back).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkerContext } from '@renderer/worker/server/types/WorkerContext'

vi.mock('fs', () => {
  const existsSync = (p: string) => p.startsWith('/p/')
  return { existsSync, default: { existsSync } }
})

const sceneObjects: { uid: number; name: string; className: string }[] = []
const fitCalls: string[] = []
vi.mock('@renderer/worker/server/services/sceneTree/sceneOps', () => ({
  focusAllViewsOnNode: (_ctx: unknown, _scene: unknown, nodeId: number, nodeType: string) =>
    fitCalls.push(`fit(${nodeType} ${nodeId})`),
}))
vi.mock('@renderer/worker/server/services/scene/listSceneObjects', () => ({
  listSceneObjects: () => ({ objects: sceneObjects }),
}))

vi.mock('@renderer/worker/server/services/helpers/makeSel', () => ({ makeSel: () => ({ sel: true }) }))

import { services as mdtoolsServices } from './mdtools.service'

interface MolOpts {
  uid: number
  className: string
  natoms: number
  src?: string
  moved?: boolean
  modified?: boolean
  srctype?: string
  /** Every atom at the origin (a topology-only file). */
  noCoords?: boolean
  /** The reader's "coord" sub-stream path. */
  coord?: string
}

function makeMol(o: MolOpts) {
  return {
    uid: o.uid,
    name: `m${o.uid}`,
    ui_order: 3,
    modified: o.modified ?? false,
    src: o.src ?? '',
    alt_src: '',
    srctype: o.srctype ?? (o.src ? 'pdb' : ''),
    xformMat: { isIdent: () => !o.moved },
    getClassName: () => o.className,
    getAtomSize: () => o.natoms,
    getAllAtomSize: () => o.natoms,
    getBoundBoxMin: () => (o.noCoords ? { x: 0, y: 0, z: 0 } : { x: -1, y: -1, z: -1 }),
    getBoundBoxMax: () => (o.noCoords ? { x: 0, y: 0, z: 0 } : { x: 1, y: 1, z: 1 }),
    getSubSrcPath: (key: string) => (key === 'coord' ? o.coord ?? '' : ''),
  }
}

function makeFixture(opts: { mols: ReturnType<typeof makeMol>[]; fileAtoms?: number; failRead?: string }) {
  const calls: string[] = []
  const objs = new Map(opts.mols.map((m) => [m.uid, m]))

  const traj: Record<string, unknown> = {
    uid: 99,
    nframe: 11,
    set name(v: string) { calls.push(`traj.name=${v}`) },
    set ui_order(v: number) { calls.push(`traj.ui_order=${v}`) },
    append: vi.fn(() => calls.push('traj.append')),
    applyLoadSel: () => calls.push('traj.applyLoadSel'),
  }

  const makeReader = (nick: string) => ({
    set targTrajUID(v: number) { calls.push(`${nick}.targTrajUID=${v}`) },
    set struct_type(v: string) { calls.push(`${nick}.struct_type=${v}`) },
    set nevery(v: number) { calls.push(`${nick}.nevery=${v}`) },
    setPath: (p: string) => calls.push(`${nick}.setPath(${p})`),
    attach: () => {},
    detach: () => {},
    createDefaultObj: () => ({}),
    read: () => {
      if (nick === opts.failRead) throw new Error('XTC: inconsistent NATOM with topology')
      calls.push(`${nick}.read`)
    },
    getFileAtomCount: () => opts.fileAtoms ?? -1,
  })

  const scene = {
    uid: 1,
    view_uids: '10',
    getObject: (uid: number) => objs.get(uid) ?? null,
    destroyObject: (uid: number) => calls.push(`scene.destroyObject(${uid})`),
    addObject: () => calls.push('scene.addObject(traj)'),
    startUndoTxn: (l: string) => calls.push(`startUndoTxn(${l})`),
    commitUndoTxn: () => calls.push('commitUndoTxn'),
    rollbackUndoTxn: () => calls.push('rollbackUndoTxn'),
  }

  const ctx = {
    sceMgr: { getScene: () => scene },
    strMgr: {
      createHandler: (nick: string) => makeReader(nick),
      toXML2: (_mol: unknown, cls: string) => { calls.push(`toXML2(${cls})`); return '<xml/>' },
      toXML2NoSubSrc: (_mol: unknown, cls: string) => { calls.push(`toXML2NoSubSrc(${cls})`); return '<xml/>' },
      fromXML: () => { calls.push('fromXML'); return traj },
    },
  } as unknown as WorkerContext

  return { ctx, calls }
}

describe('attachTrajectory', () => {
  beforeEach(() => { sceneObjects.length = 0; fitCalls.length = 0 })

  it('converts a molecule in one txn, keeping its coordinates as frame 0', () => {
    const mol = makeMol({ uid: 5, className: 'MolCoord', natoms: 100, src: '/p/m.pdb' })
    const { ctx, calls } = makeFixture({ mols: [mol] })

    const res = mdtoolsServices.attachTrajectory(ctx, { sceneId: 1, objId: 5, trajPaths: ['/p/a.xtc'] })

    expect(res).toEqual({ ok: true, objId: 99, nframe: 11 })
    expect(calls).toEqual([
      'startUndoTxn(Attach MD trajectory)',
      'toXML2(Trajectory)',
      'fromXML',
      'traj.name=m5',
      'scene.destroyObject(5)',
      'scene.addObject(traj)',
      'traj.ui_order=3',
      'structframe.targTrajUID=99',
      'structframe.struct_type=pdb',
      'structframe.setPath(/p/m.pdb)',
      'structframe.read',
      'traj.append',
      'xtctraj.targTrajUID=99',
      'xtctraj.setPath(/p/a.xtc)',
      'xtctraj.read',
      'traj.append',
      'commitUndoTxn',
    ])
  })

  it('moves a coordinate sub-stream to the frame-0 block; no coordinates means no frame-0 block and a view fit', () => {
    // prmtop + rst7: the topology is read back alone, the rst7 is frame 0.
    const prm = makeMol({ uid: 5, className: 'MolCoord', natoms: 3, src: '/p/s.prmtop', srctype: 'amberprm', coord: '/p/s.rst7' })
    const a = makeFixture({ mols: [prm] })
    expect(mdtoolsServices.attachTrajectory(a.ctx, { sceneId: 1, objId: 5, trajPaths: ['/p/a.dcd'] }).ok).toBe(true)
    expect(a.calls.filter((c) => /^(toXML|\w+\.setPath)/.test(c))).toEqual([
      'toXML2NoSubSrc(Trajectory)',
      'amberrst.setPath(/p/s.rst7)',
      'dcdtraj.setPath(/p/a.dcd)',
    ])
    expect(fitCalls).toEqual([])

    // A topology-only PSF: no frame-0 block; the views fit after the commit.
    const psf = makeMol({ uid: 6, className: 'MolCoord', natoms: 3, src: '/p/s.psf', srctype: 'psf', noCoords: true })
    const b = makeFixture({ mols: [psf] })
    expect(mdtoolsServices.attachTrajectory(b.ctx, { sceneId: 1, objId: 6, trajPaths: ['/p/a.dcd'] }).ok).toBe(true)
    expect(b.calls.filter((c) => /^(toXML|\w+\.setPath)/.test(c))).toEqual([
      'toXML2(Trajectory)',
      'dcdtraj.setPath(/p/a.dcd)',
    ])
    expect(b.calls[b.calls.length - 1]).toBe('commitUndoTxn')
    expect(fitCalls).toEqual(['fit(object 99)'])
  })

  it('rolls the conversion back when a trajectory file fails to read', () => {
    const mol = makeMol({ uid: 5, className: 'MolCoord', natoms: 100, src: '/p/m.pdb' })
    const { ctx, calls } = makeFixture({ mols: [mol], failRead: 'xtctraj' })

    const res = mdtoolsServices.attachTrajectory(ctx, { sceneId: 1, objId: 5, trajPaths: ['/p/a.xtc'] })

    expect(res).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/NATOM/) }))
    expect(calls).toContain('rollbackUndoTxn')
    expect(calls).not.toContain('commitUndoTxn')
  })

  it('lists only molecules with the files\' atom count, greying those it cannot convert', () => {
    const mols = [
      makeMol({ uid: 1, className: 'MolCoord', natoms: 100, src: '/p/ok.pdb' }),
      makeMol({ uid: 2, className: 'MolCoord', natoms: 50, src: '/p/small.pdb' }),
      makeMol({ uid: 3, className: 'MorphMol', natoms: 100, src: '/p/morph.pdb' }),
      makeMol({ uid: 4, className: 'MolCoord', natoms: 100, src: '/p/moved.pdb', moved: true }),
      makeMol({ uid: 5, className: 'MolCoord', natoms: 100, src: '/p/edited.pdb', modified: true }),
      makeMol({ uid: 6, className: 'MolCoord', natoms: 100 }),
      makeMol({ uid: 7, className: 'Trajectory', natoms: 100 }),
    ]
    for (const m of mols) sceneObjects.push({ uid: m.uid, name: m.name, className: m.getClassName() })
    const { ctx } = makeFixture({ mols, fileAtoms: 100 })

    const res = mdtoolsServices.listAttachTargets(ctx, { sceneId: 1, paths: ['/p/a.xtc'] })

    expect(res.fileAtoms).toBe(100)
    expect(res.mismatched).toBe(1)
    expect(res.targets.map((t) => [t.uid, t.reason ?? ''])).toEqual([
      [1, ''],
      [4, expect.stringMatching(/transformation matrix/)],
      [5, expect.stringMatching(/edited/)],
      [6, expect.stringMatching(/no original file/)],
      [7, ''],
    ])
  })

  it('replace on a trajectory removes every block, then appends, in one txn', () => {
    const mol = {
      ...makeMol({ uid: 7, className: 'Trajectory', natoms: 100 }),
      nblock: 2,
      nframe: 5,
      removeBlock: (i: number) => calls.push(`removeBlock(${i})`),
      append: () => calls.push('traj.append'),
    }
    const { ctx, calls } = makeFixture({ mols: [mol] })

    const res = mdtoolsServices.attachTrajectory(ctx, { sceneId: 1, objId: 7, trajPaths: ['/p/a.xtc'], replace: true })

    expect(res).toMatchObject({ ok: true, objId: 7 })
    expect(calls).toEqual([
      'startUndoTxn(Attach MD trajectory)',
      'removeBlock(1)',
      'removeBlock(0)',
      'xtctraj.targTrajUID=7',
      'xtctraj.setPath(/p/a.xtc)',
      'xtctraj.read',
      'traj.append',
      'commitUndoTxn',
    ])
  })

  it('applies a load selection to a converted molecule before its frame 0, and refuses it for a trajectory', () => {
    const mol = makeMol({ uid: 5, className: 'MolCoord', natoms: 100, src: '/p/m.pdb' })
    const { ctx, calls } = makeFixture({ mols: [mol] })
    expect(mdtoolsServices.attachTrajectory(ctx, { sceneId: 1, objId: 5, trajPaths: ['/p/a.xtc'], loadSel: 'name CA' }).ok).toBe(true)
    expect(calls.indexOf('traj.applyLoadSel')).toBeGreaterThan(calls.indexOf('scene.addObject(traj)'))
    expect(calls.indexOf('traj.applyLoadSel')).toBeLessThan(calls.indexOf('structframe.read'))

    const traj = makeMol({ uid: 7, className: 'Trajectory', natoms: 100 })
    const f = makeFixture({ mols: [traj] })
    expect(mdtoolsServices.attachTrajectory(f.ctx, { sceneId: 1, objId: 7, trajPaths: ['/p/a.xtc'], loadSel: 'name CA' }))
      .toMatchObject({ ok: false, code: 'invalid-args' })
    expect(f.calls).toEqual([])
  })
})
