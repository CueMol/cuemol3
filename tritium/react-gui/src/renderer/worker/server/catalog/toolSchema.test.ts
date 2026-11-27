/**
 * @file worker/server/catalog/toolSchema.test.ts
 * @description How a JSON caller's arguments are read: the string "null" a
 * model sometimes writes for the null of a nullable argument.
 */

import { describe, it, expect } from 'vitest'
import { defineOp } from './op'
import { enumOf, optional, string } from './params'
import { readToolArgs } from './toolSchema'

const op = defineOp({
  name: 'fetch_pdb',
  description: 'Fetch.',
  params: {
    pdbId: string('Entry.'),
    preset: optional(string('Preset. Null leaves it.')),
    policy: optional(enumOf(['auto', 'setMapCenter'], 'Policy. Null is auto.')),
  },
  mutates: true,
  group: 'files',
  expose: { tool: 'core', console: false },
  run: () => ({ ok: true }),
})

describe('readToolArgs', () => {
  it('reads "null" in an optional argument as null for a model-facing caller, and as written otherwise', () => {
    // A model's "null": left out, for a free-text and an enum argument alike.
    expect(readToolArgs(op, { pdbId: 'null', preset: 'null', policy: 'null' }, { nullString: true })).toEqual({
      pdbId: 'null',
      preset: null,
      policy: null,
    })
    // A replayed record: "null" is a name the op really took.
    expect(readToolArgs(op, { pdbId: '1ema', preset: 'null' })).toEqual({ pdbId: '1ema', preset: 'null', policy: null })
  })
})
