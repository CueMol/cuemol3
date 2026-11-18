/**
 * Empty-state watermark shown in the content area when no tab is open
 * (VSCode-like). Not a tab pane itself -- ContentPane renders it as the
 * fallback when the tab list is empty.
 *
 * Displays the app branding and the shortcuts for getting started, one row
 * each: icon | command | shortcut. They are quoted from their single sources
 * rather than retyped: the name from `APP_PRODUCT_NAME`, each shortcut's
 * label and accelerator from `APP_MENU`, filtered by the same GUI gate the
 * menu uses. This pane fell out of date once already (it still said
 * "CueMol2" and listed two shortcuts the app never bound), which is what
 * deriving them prevents.
 */

import React from "react";
import { Tag } from "@blueprintjs/core";
import welcomeIcon from "@renderer/assets/cuemol3-icon-shadow.png";
import { AppIcon } from "@renderer/h3-kit/primitives";
import type { AppIconKey } from "@renderer/h3-kit/primitives";
import { APP_PRODUCT_NAME } from "@shared/appInfo";
import { findMenuItemById } from "@shared/menuTemplate";
import { formatAccelerator } from "@shared/menuAccel";
import { isAvailable } from "@shared/guiGate";

/**
 * Menu items quoted on the start screen, in display order, each with the
 * toolbar icon of the same action. Only the ones the GUI gate allows with no
 * tab open are shown, so the screen never offers a key that does nothing.
 */
const SHORTCUTS: readonly { id: string; icon: AppIconKey }[] = [
  { id: "new-tab", icon: "toolbar.newTab" },
  { id: "open-file", icon: "toolbar.openFile" },
  { id: "open-scene", icon: "toolbar.openScene" },
];

interface Shortcut {
  id: string;
  icon: AppIconKey;
  label: string;
  accel: string;
}

/** Resolve the quoted ids to label + display accelerator, dropping any that
 *  no longer exist, lost their accelerator, or are unusable with no tab. */
function getShortcuts(isMac: boolean): Shortcut[] {
  return SHORTCUTS.flatMap(({ id, icon }) => {
    const item = findMenuItemById(id);
    const accel = isMac ? item?.acceleratorMac ?? item?.accelerator : item?.accelerator;
    if (!item?.label || !accel) return [];
    if (!isAvailable(item.availability, { tab: "none" })) return [];
    return [{ id, icon, label: item.label.replace(/\.\.\.$/, ""), accel: formatAccelerator(accel, isMac) }];
  });
}

export const WelcomePane: React.FC = () => {
  const isMac = window.electronAPI?.platform === "darwin";
  const shortcuts = getShortcuts(isMac);

  return (
    <div className="editor-placeholder">
      <img className="placeholder-app-icon" src={welcomeIcon} alt="" aria-hidden="true" />
      <div className="placeholder-title">{APP_PRODUCT_NAME}</div>
      <div className="placeholder-subtitle">Molecular Visualization System</div>
      <div className="shortcut-group">
        {shortcuts.map((s) => (
          <div className="shortcut-item" key={s.id}>
            <AppIcon name={s.icon} size={16} className="shortcut-icon" aria-hidden />
            <span className="shortcut-label">{s.label}</span>
            <Tag minimal className="shortcut-key">
              {s.accel}
            </Tag>
          </div>
        ))}
      </div>
    </div>
  );
};
