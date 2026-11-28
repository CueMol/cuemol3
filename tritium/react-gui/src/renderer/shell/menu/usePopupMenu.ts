/**
 * @file shell/menu/usePopupMenu.ts
 * @description Open a dropdown menu under a button as the platform's menu:
 * the native menu on macOS (`IPC.POPUP_MENU_SHOW`, main pops the tree), the
 * React `MenuPanel` on Windows / Linux (`ContextMenuProvider`), the same
 * surfaces the context menus use.
 *
 * For a dropdown whose rows are plain items -- labels, checks, swatches,
 * separators, submenus. One that needs its own content (a search box, a
 * preview) stays a Blueprint Popover.
 */

import { useCallback } from 'react'
import { IPC } from '@shared/ipcChannels'
import type { MenuNode } from '@shared/menuNodes'
import { useShowContextMenu } from './ContextMenuProvider'

/**
 * Returns `open(nodes, anchor)`: shows `nodes` just below `anchor`'s bottom-
 * left corner and resolves with the picked node's action, or null on
 * dismiss.
 *
 * @remarks On macOS the actions cross IPC, so they must be plain data.
 */
export function usePopupMenu(): <T>(nodes: MenuNode<T>[], anchor: Element) => Promise<T | null> {
    const showContextMenu = useShowContextMenu()
    return useCallback(
        async <T,>(nodes: MenuNode<T>[], anchor: Element): Promise<T | null> => {
            const r = anchor.getBoundingClientRect()
            const pos = { x: r.left, y: r.bottom }
            const api = window.electronAPI
            if (api?.platform === 'darwin') {
                const picked = await api.invoke(IPC.POPUP_MENU_SHOW, { nodes, ...pos })
                return (picked ?? null) as T | null
            }
            return await showContextMenu(nodes, pos)
        },
        [showContextMenu],
    )
}
