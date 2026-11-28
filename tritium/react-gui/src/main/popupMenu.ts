/**
 * @file main/popupMenu.ts
 * @description Native popup of any shared `MenuNode` tree, for a pane's
 * dropdown menu on macOS (`renderer/shell/menu/usePopupMenu.ts`). Unlike the
 * scene-tree and viewport menus, the renderer builds the tree itself and main
 * only shows it, so one channel serves every dropdown.
 *
 * Action contract as in `sceneContextMenu.ts`: Electron fires an item's
 * `click` before the popup `callback`, so `chosen` holds the pick (or null
 * for a dismiss) by the time the Promise resolves.
 */
import { Menu } from 'electron'
import type { BrowserWindow } from 'electron'
import type { PopupMenuRequest } from '@shared/ipcContract'
import { toElectronTemplate } from './menuNodeAdapter'

/** Pop `req.nodes` at `req.x`, `req.y` in `win`; resolves with the picked action or null. */
export function showPopupMenu(win: BrowserWindow, req: PopupMenuRequest): Promise<unknown> {
  return new Promise((resolve) => {
    let chosen: unknown = null
    const menu = Menu.buildFromTemplate(
      toElectronTemplate(req.nodes, (action) => {
        chosen = action
      }),
    )
    menu.popup({
      window: win,
      x: Math.round(req.x),
      y: Math.round(req.y),
      callback: () => resolve(chosen),
    })
  })
}
