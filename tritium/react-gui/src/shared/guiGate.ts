/**
 * @file shared/guiGate.ts
 * @description The one rule deciding whether a GUI action (menu item,
 * toolbar button, bottom-panel tab) is usable right now.
 *
 * Each action declares what it needs (`Availability`); the renderer reports
 * the GUI state (`GuiGate`); `isAvailable` combines the two. Every surface --
 * the native menu in main, the React menu bar and its keybindings, the
 * toolbar and the bottom panel -- asks this function and nothing else, so a
 * new state (e.g. busy) is added here and in the one hook that builds the
 * gate, without touching the callers.
 */

import type { RecentFileEntry } from './types/recent'

/**
 * What an action needs to be usable.
 *   - `'always'`: never touches the front scene (New Tab, Open Scene, About...).
 *   - `'loadIntoScene'`: loads into the front scene, or into a new one when no
 *     tab is open (Open File, Get PDB...).
 *   - undefined: needs a molview tab in front. An action that declares
 *     nothing lands here, so a forgotten declaration fails safe.
 */
export type Availability = 'always' | 'loadIntoScene'

/** The GUI state actions are gated on. Built in the renderer only. */
export interface GuiGate {
  /** Kind of the front editor tab: a molview, any other tab, or no tab. */
  tab: 'molview' | 'other' | 'none'
}

/** Whether an action declaring `availability` is usable under `gate`. */
export function isAvailable(availability: Availability | undefined, gate: GuiGate): boolean {
  switch (availability) {
    case 'always':
      return true
    case 'loadIntoScene':
      return gate.tab !== 'other'
    default:
      return gate.tab === 'molview'
  }
}

/**
 * Availability of an Open Recent entry: a scene opens like Open Scene, any
 * other file like Open File. Uses `ftype`, the same field the click is routed
 * by, so the gate and the action can never disagree.
 */
export function recentAvailability(entry: Pick<RecentFileEntry, 'ftype'>): Availability {
  return entry.ftype === 'scene' ? 'always' : 'loadIntoScene'
}
