/**
 * @file shared/types/menuState.ts
 * @description Native application-menu state pushed from the renderer.
 *
 * Part of the main <-> renderer IPC contract (see shared/ipcContract.ts).
 * Types only: nothing in shared/types/ may import main/ or renderer/ code.
 */

import type { GuiGate } from '../guiGate'

export type ViewCenterMark = 'none' | 'crosshair' | 'axis'

export type SceneBgColor = 'white' | 'black' | 'other'

export interface MenuState {
  viewProjection?: {
    enabled: boolean
    perspective: boolean | null
  }
  viewCenterMark?: {
    enabled: boolean
    centerMark: ViewCenterMark | null
  }
  sceneBgColor?: {
    enabled: boolean
    bgColor: SceneBgColor | null
  }
  /**
   * Scene > Use color proofing. `checked` reflects the scene's live flag,
   * which is on only when a profile is actually configured (the worker
   * reports the combination, not the raw `use_colproof`).
   */
  sceneColorProof?: {
    enabled: boolean
    checked: boolean
  }
  /**
   * View > Tool palette. `visible` mirrors the renderer's persisted layout
   * flag (the palette folded to its cap), so the check survives a menu
   * rebuild and matches a state restored at startup.
   */
  toolPalette?: {
    visible: boolean
  }
  undo?: {
    enabled: boolean
  }
  redo?: {
    enabled: boolean
  }
  /**
   * The GUI state every gated item is decided by (see shared/guiGate.ts).
   * Built by the renderer's `useGuiGate` and replaced as a whole.
   */
  guiGate?: GuiGate
  /**
   * Scene-exporter availability for the running libcuemol2 build: the set of
   * exporter nicknames registered in category 2. Export menu items whose
   * exporter is absent are hidden. An empty array is treated as "unknown" and
   * hides nothing (fail-open); pushed once at startup after the worker probe.
   */
  exportCaps?: {
    available: string[]
  }
}
