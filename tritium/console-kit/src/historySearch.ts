/**
 * @file historySearch.ts
 * @description Ctrl-R through the command history, as zsh's
 * history-incremental-search-backward does it, for the console panel and
 * tritium_cli alike.
 *
 * Pure functions over a state value: each takes the history (newest first)
 * and returns the next state, and the client draws `searchLine` /
 * `searchPrompt` and decides what a key means. The steps:
 *
 * - typing extends the pattern and looks for it from the current match back
 *   (the current line still counts, as it may hold the longer pattern too);
 * - Ctrl-R again goes to the next older line holding it; with nothing typed
 *   yet it searches for the previous search's pattern;
 * - a pattern found nowhere is "failing": the line keeps the last match;
 * - Backspace undoes the last step, a typed character or a Ctrl-R alike.
 *
 * Two departures from zsh, both for simplicity: a line is matched once
 * however often the pattern occurs in it, and there is no forward search
 * (Ctrl-S is the terminal's flow control in a default zsh, and Save Scene in
 * the app on Windows / Linux).
 */

/** The part of the state Backspace returns to. */
interface SearchStep {
  pattern: string
  /** The matched line's index in the history (newest 0); null before the first match. */
  index: number | null
  /** Where the pattern starts in that line. */
  at: number
  failing: boolean
}

/** A search in progress. */
export interface HistorySearch extends SearchStep {
  /** The line as it was when the search started, shown until something matches. */
  original: string
  /** Earlier steps, for Backspace. */
  stack: readonly SearchStep[]
}

/** What the input line shows for a search. */
export interface SearchLine {
  line: string
  /** Where the caret goes: the start of the match. */
  caret: number
  /** How long the match is (to highlight); 0 while failing or before a match. */
  matchLength: number
}

/** Start a search over the line `original`. */
export function startSearch(original: string): HistorySearch {
  return { original, pattern: '', index: null, at: 0, failing: false, stack: [] }
}

function stepOf(s: HistorySearch): SearchStep {
  return { pattern: s.pattern, index: s.index, at: s.at, failing: s.failing }
}

/** The first line at or after `from` (going back in time) that holds `pattern`. */
function findFrom(history: readonly string[], pattern: string, from: number): { index: number; at: number } | null {
  for (let i = from; i < history.length; i++) {
    const at = history[i].indexOf(pattern)
    if (at >= 0) return { index: i, at }
  }
  return null
}

/** `s` searching for `pattern` from history index `from`: the match, or failing where it was. */
function searchAt(s: HistorySearch, history: readonly string[], pattern: string, from: number): HistorySearch {
  const stack = [...s.stack, stepOf(s)]
  const found = pattern === '' ? null : findFrom(history, pattern, from)
  if (found) return { ...s, pattern, index: found.index, at: found.at, failing: false, stack }
  return { ...s, pattern, failing: pattern !== '', stack }
}

/** A character typed into the pattern. */
export function typeSearch(s: HistorySearch, ch: string, history: readonly string[]): HistorySearch {
  return searchAt(s, history, s.pattern + ch, s.index ?? 0)
}

/**
 * Ctrl-R again: the next older line holding the pattern. With nothing typed,
 * the previous search's pattern (zsh's Ctrl-R Ctrl-R).
 *
 * @param lastPattern - the pattern the previous search ended with ('' for none)
 */
export function repeatSearch(s: HistorySearch, history: readonly string[], lastPattern: string): HistorySearch {
  if (s.pattern === '') return lastPattern === '' ? s : searchAt(s, history, lastPattern, 0)
  return searchAt(s, history, s.pattern, s.index === null ? 0 : s.index + 1)
}

/** Backspace: undo the last step. */
export function backspaceSearch(s: HistorySearch): HistorySearch {
  const prev = s.stack.at(-1)
  if (!prev) return s
  return { ...s, ...prev, stack: s.stack.slice(0, -1) }
}

/** The line to show, and where the caret and the highlight go. */
export function searchLine(s: HistorySearch, history: readonly string[]): SearchLine {
  const line = s.index === null ? undefined : history[s.index]
  if (line === undefined) return { line: s.original, caret: s.original.length, matchLength: 0 }
  return { line, caret: s.at, matchLength: s.failing ? 0 : s.pattern.length }
}

/** The status line: `bck-i-search: pat`, or `failing bck-i-search: pat`. */
export function searchPrompt(s: HistorySearch): string {
  return `${s.failing ? 'failing ' : ''}bck-i-search: ${s.pattern}`
}
