/**
 * @file shell/menu/useGuiGateMenuSync.ts
 * @description Pushes the GUI gate to the native menu, which lives in main and
 * cannot read renderer state.
 *
 * Main decides each gated item (and each Open Recent row) from this value with
 * the same `isAvailable` the renderer uses. The Windows / Linux React menu bar
 * reads the gate directly through `useMenuBarState` and needs no push.
 */
import { useEffect } from 'react'
import { IPC } from '@shared/ipcChannels'
import { useGuiGate } from '@renderer/state/workspace'

/** Mirror the current `GuiGate` onto the native menu. */
export function useGuiGateMenuSync(): void {
  const guiGate = useGuiGate()
  useEffect(() => {
    window.electronAPI
      ?.invoke(IPC.MENU_UPDATE_STATE, { guiGate })
      .catch((err: unknown) => {
        console.warn('update menu state (gui gate) failed:', err)
      })
  }, [guiGate])
}
