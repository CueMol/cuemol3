/**
 * @file historySearch.test.ts
 * @description Ctrl-R's steps as both clients drive them.
 */

import { describe, it, expect } from 'vitest'
import { backspaceSearch, repeatSearch, searchLine, searchPrompt, startSearch, typeSearch } from './historySearch'
import type { HistorySearch } from './historySearch'

// Newest first, as the clients keep it.
const history = ['color red, 1crn', 'load 2abc.pdb', 'show cartoon', 'load 1crn.pdb']

const type = (s: HistorySearch, text: string) => [...text].reduce((t, ch) => typeSearch(t, ch, history), s)

describe('history search', () => {
  it('walks back through the matches, and Backspace undoes a step', () => {
    let s = type(startSearch('draft'), 'load')
    expect(searchLine(s, history)).toEqual({ line: 'load 2abc.pdb', caret: 0, matchLength: 4 })
    expect(searchPrompt(s)).toBe('bck-i-search: load')

    s = repeatSearch(s, history, '')
    expect(searchLine(s, history).line).toBe('load 1crn.pdb')
    // A longer pattern still matches the line it is on.
    s = type(s, ' 1')
    expect(searchLine(s, history)).toEqual({ line: 'load 1crn.pdb', caret: 0, matchLength: 6 })

    s = backspaceSearch(backspaceSearch(backspaceSearch(s)))
    expect(searchLine(s, history).line).toBe('load 2abc.pdb')
  })

  it('keeps the last match while failing, and starts from the previous pattern on an empty Ctrl-R', () => {
    let s = type(startSearch('draft'), '1crn')
    expect(searchLine(s, history)).toEqual({ line: 'color red, 1crn', caret: 11, matchLength: 4 })
    s = type(s, 'x')
    expect(searchPrompt(s)).toBe('failing bck-i-search: 1crnx')
    // The line stays, the highlight goes.
    expect(searchLine(s, history)).toEqual({ line: 'color red, 1crn', caret: 11, matchLength: 0 })

    // Nothing typed yet: the line is the draft, and Ctrl-R reuses the last pattern.
    const fresh = startSearch('draft')
    expect(searchLine(fresh, history)).toEqual({ line: 'draft', caret: 5, matchLength: 0 })
    expect(repeatSearch(fresh, history, '')).toBe(fresh)
    expect(searchLine(repeatSearch(fresh, history, 'cartoon'), history).line).toBe('show cartoon')
  })
})
