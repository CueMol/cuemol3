/**
 * Bottom panel with VSCode-style tabbed switching between the Output log,
 * the Animation timeline. (Render execution
 * lives in the modeless Rendering window -- see RenderWindowApp.)
 *
 * The Output tab renders `LogPanel` (pre-element based). The log
 * subscription (`useLogEvent`) and accumulated buffer live here, not
 * inside `LogPanel`, so that switching to another tab does not unmount
 * the buffer or drop incoming messages from the cuemol3 core.
 *
 * Plugins contribute tabs of their own; the Sequence panel is one. A
 * contributed tab gets the same scene / view props a built-in one does.
 * The leftmost tab (the Console, when its plugin is on) is in front until
 * the user picks another.
 *
 * A tab that works on the front scene declares `requiresMolView`. While the
 * GUI gate says no molview tab is in front, it shows a notice to switch to
 * one in place of its content. The tab buttons stay usable. Nothing a panel
 * keeps is lost: the console transcript lives in its session store, so a CLI
 * run meanwhile is there when a molview tab comes back.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AppIcon } from "@renderer/h3-kit/primitives";
import type { AppIconKey } from "@renderer/h3-kit/primitives";
import { PanelTabButton } from "./PanelTabButton";
import { LogPanel } from "@renderer/features/log/LogPanel";
import { AnimationPanel } from "@renderer/features/animation/AnimationPanel";
import { insertAfterId, onRevealBottomTab, usePluginContributions } from "@renderer/plugin-host";
import type { ResolvedPluginBottomTab } from "@renderer/plugin-host";
import { useLogActions, useLogContents } from "@renderer/contexts/LogContext";
import { IPC } from "@shared/ipcChannels";
import { useCueMol } from "@renderer/hooks/cuemol/useCueMol";
import { useActiveScene, useGuiGate } from "@renderer/state/workspace";
import { isAvailable } from "@shared/guiGate";

// ---------------------------------------------
// Types
// ---------------------------------------------

/**
 * Tab identifier. A plain string rather than a union of the built-ins,
 * because a plugin names its own tab.
 */
type BottomTabType = string;

/** One entry in the tab strip. */
interface BottomTabDef {
  id: BottomTabType;
  label: string;
  icon: AppIconKey;
  /** Content works on the front scene; disabled while no molview tab is in front. */
  requiresMolView?: boolean;
}

/** The tabs the application itself owns, in left-to-right order. */
const BUILTIN_BOTTOM_TABS: readonly BottomTabDef[] = [
  { id: "output", label: "Output", icon: "panel.output" },
  { id: "animation", label: "Animation", icon: "panel.animation", requiresMolView: true },
];

/** The tab strip for the enabled plugins: built-ins with the contributions spliced in. */
function buildBottomTabs(contributed: readonly ResolvedPluginBottomTab[]): BottomTabDef[] {
  let tabs: BottomTabDef[] = [...BUILTIN_BOTTOM_TABS];
  for (const tab of contributed) {
    const at = tab.before === undefined ? -1 : tabs.findIndex((t) => t.id === tab.before);
    tabs = at >= 0
      ? [...tabs.slice(0, at), tab, ...tabs.slice(at)]
      : insertAfterId(tabs, [tab], tab.after, (t) => t.id);
  }
  return tabs;
}

interface TabButtonProps {
  tab: BottomTabType;
  activeTab: BottomTabType;
  icon: AppIconKey;
  label: string;
  onClick: (tab: BottomTabType) => void;
}

// ---------------------------------------------
// Sub-component: TabButton
// ---------------------------------------------

const TabButton: React.FC<TabButtonProps> = (props) => (
  <PanelTabButton<BottomTabType> {...props} />
);

// ---------------------------------------------
// Main Component
// ---------------------------------------------


const BottomPanelComponent: React.FC = () => {
  const { cm } = useCueMol();
  const { activeSceneId, activeMolViewId } = useActiveScene();
  // The tab the user picked; until then (and when the picked tab's plugin is
  // switched off) the leftmost tab is in front. Derived rather than set once,
  // because plugin tabs arrive after the first render.
  const [pickedTab, setActiveTab] = useState<BottomTabType | null>(null);
  const { bottomTabs: contributedTabs } = usePluginContributions();
  const tabs = useMemo(() => buildBottomTabs(contributedTabs), [contributedTabs]);
  const activeTab = pickedTab !== null && tabs.some((t) => t.id === pickedTab) ? pickedTab : tabs[0].id;
  // A tab brought to the front from elsewhere (revealBottomTab) counts as
  // picked; an id with no tab falls back like a switched-off plugin's.
  useEffect(() => onRevealBottomTab(setActiveTab), []);

  // `requiresMolView` means "needs a molview tab in front", which is the
  // gate's default (undeclared) availability.
  const gate = useGuiGate();
  const activeDef = tabs.find((t) => t.id === activeTab);
  const disabled = activeDef?.requiresMolView === true && !isAvailable(undefined, gate);

  // The log buffer lives in LogProvider (so renderer-side code can append via
  // useLogPanel() and it survives tab switches); the Output-tab UI state stays
  // local to the always-mounted BottomPanel.
  const logContents = useLogContents();
  const { clear: clearLog } = useLogActions();
  const [logFilter, setLogFilter] = useState("");
  const [logAutoScroll, setLogAutoScroll] = useState(true);

  const handleClearLog = useCallback(() => clearLog(), [clearLog]);
  const handleToggleAutoScroll = useCallback(() => setLogAutoScroll((v) => !v), []);
  const handleSaveLogAs = useCallback(async () => {
    // Save the unfiltered buffer so downstream readers get the full
    // debugging trail regardless of the current Filter input.
    const res = await window.electronAPI.invoke(IPC.SAVE_TEXT_AS, {
      defaultName: "output.log",
      content: logContents,
    });
    if (res.error) {
      console.error("Save Output As failed:", res.error);
    }
  }, [logContents]);

  const renderContent = () => {
    switch (activeTab) {
      case "output":
        return (
          <LogPanel
            contents={logContents}
            filter={logFilter}
            autoScroll={logAutoScroll}
            onFilterChange={setLogFilter}
            onAutoScrollToggle={handleToggleAutoScroll}
            onClear={handleClearLog}
            onSaveAs={handleSaveLogAs}
          />
        );
      case "animation":
        return (
          <AnimationPanel
            cm={cm}
            activeSceneId={activeSceneId}
            activeMolViewId={activeMolViewId}
          />
        );
      default: {
        const contributed = contributedTabs.find((t) => t.id === activeTab);
        if (!contributed) return null;
        const Panel = contributed.Component;
        return (
          <Panel
            cm={cm}
            activeSceneId={activeSceneId}
            activeMolViewId={activeMolViewId}
          />
        );
      }
    }
  };

  return (
    <div className="bottom-panel">
      <div className="bottom-panel-tabs">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab.id}
            activeTab={activeTab}
            icon={tab.icon}
            label={tab.label}
            onClick={setActiveTab}
          />
        ))}
      </div>
      <div className="bottom-panel-content">
        {disabled && activeDef ? (
          <div className="bottom-panel-placeholder">
            <AppIcon name={activeDef.icon} size={48} className="placeholder-icon" aria-hidden />
            <div>Switch to a molecule view tab to use this panel.</div>
          </div>
        ) : (
          renderContent()
        )}
      </div>
    </div>
  );
};

/**
 * Props-free: re-renders for the log buffer and the active scene it
 * reads, not for anything happening in the sidebar or the inspector.
 */
export const BottomPanel = React.memo(BottomPanelComponent)
BottomPanel.displayName = 'BottomPanel'
