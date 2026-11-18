/**
 * @file shell/AppCommands.tsx
 * @description Mounts every CmdId handler and the Electron IPC bridge.
 *
 * A component rather than a call in App so the provider subscriptions the
 * handlers need re-render this and nothing else.
 */

import React from 'react'
import { useCommandRegistrations } from '@renderer/hooks/useCommandRegistrations'
import { useToolPaletteMenuSync } from '@renderer/shell/menu/useToolPaletteMenuSync'
import { useGuiGateMenuSync } from '@renderer/shell/menu/useGuiGateMenuSync'

/** Separate so the tab-strip subscription it needs re-renders only this. */
const GuiGateMenuSync: React.FC = () => {
  useGuiGateMenuSync()
  return null
}

export const AppCommands: React.FC = () => {
  useCommandRegistrations()
  useToolPaletteMenuSync()
  return <GuiGateMenuSync />
}
