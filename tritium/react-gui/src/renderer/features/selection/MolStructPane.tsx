/**
 * @file features/selection/MolStructPane.tsx
 * @description Side-panel surface that mirrors UXP `panel.molstruct`
 * (`uxp_gui/cuemol2/base/content/molstruct-panel.{xul,js}`).
 *
 * Contents:
 *   - molecule selector (`HTMLSelect` over MolCoord-like scene objects)
 *   - chain / residue / atom tree (Blueprint `Tree`, multi-select)
 *   - toolbar: Select / Center / Zoom / Properties
 *
 * Residue / atom rows are lazy-loaded on expand via `useMolStructure`;
 * the worker round-trip only happens the first time a node opens. A chain
 * shows its residues RESIDUE_PAGE at a time: Blueprint `Tree` is not virtualized, so a chain of tens of thousands
 * of residues (the waters of an MD system) drawn at once blocked the main
 * thread, and with it any way to collapse the chain again. The next page is
 * added when the chain's last row ("Loading more...") scrolls into view.
 * Center / Zoom drive `selectAndFocusMol` (set the selection, then move
 * the view to it) using the active mol-view's id. Properties opens the one
 * selected row (chain / residue / atom) in the inspector, read-only; it is
 * off for none or several rows. Double-clicking a row opens that row, as in
 * the other tree panes. (UXP's `onBtnPropCmd` was empty.)
 *
 * @module MolStructPane
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Button,
    ButtonGroup,
    type TreeNodeInfo,
} from "@blueprintjs/core";
import { ListboxTree } from "@renderer/h3-kit/list";
import { AppIcon, Tooltip } from "@renderer/h3-kit/primitives";
import { PaneSectionHeader } from "@renderer/shell/PaneSectionHeader";
import { useMolStructure } from "./useMolStructure";
import { ObjectSelect, objectFilters } from "@renderer/h3-kit/ObjectSelect";
import type { AsyncCueMol } from "@renderer/worker/client/AsyncCueMol";
import type { ServiceArgs } from "@renderer/worker/shared/calls";
import { pushHistory } from "@renderer/h3-kit/MolSelList";
import {
    encodeChainId,
    encodeResidueId,
    encodeAtomId,
    decodeMolTreeId,
    selStrFromTree,
    type MolTreeId,
} from "@renderer/features/selection/molStruct/selStrFromTree";
import { useInspectorActions } from "@renderer/state/inspector";
import { useCueMol } from "@renderer/hooks/cuemol/useCueMol";
import { useActiveScene } from "@renderer/state/workspace";

type SelApplyService = "applyMolSelString" | "selectAndFocusMol";

/**
 * Apply a tree-derived expression through one of the mol-selection services
 * and record it in the selection history once the worker applied it. A
 * rejected call is logged, like the fire-and-forget helper it replaces.
 */
function applyAndRecord<K extends SelApplyService>(
    cm: AsyncCueMol,
    name: K,
    args: ServiceArgs<K> & { selStr: string },
): void {
    cm.invokeService(name, args)
        .then((res) => {
            if (res.ok) pushHistory(args.selStr);
        })
        .catch((err: unknown) => console.warn(`${name} failed:`, err));
}

/* --- Constants --- */

/**
 * Empty icon-column spacer for placeholder rows ("Loading...", "(no atoms)")
 * so their labels align with sibling rows that do carry an icon. Blueprint's
 * `Tree` reserves no icon gutter when `icon` is omitted, hence the spacer.
 */
const BLANK_ICON = <span style={{ display: "inline-block", width: 16 }} aria-hidden />;

/** How many residue rows an expanded chain shows at first, and adds each time its end scrolls into view. */
export const RESIDUE_PAGE = 500;

/** Id prefix of a chain's "Loading more..." row, the last row while residues remain. */
const MORE_PREFIX = "more-resid:";

/** How far below the visible area the "Loading more..." row starts the next page, in px. */
const MORE_MARGIN_PX = 200;

/* --- Props --- */

interface MolStructPaneProps {
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}

/* --- Component --- */

export const MolStructPane: React.FC<MolStructPaneProps> = ({ collapsed, onToggleCollapse }) => {
    const { cm } = useCueMol();
    const { activeSceneId, activeMolViewId } = useActiveScene();

    const [selectedMolId, setSelectedMolId] = useState<number | undefined>(undefined);
    const {
        chains,
        residuesByChain,
        atomsByResidue,
        loadResidues,
        loadAtoms,
    } = useMolStructure({ cm, sceneId: activeSceneId, molId: selectedMolId });

    // Multi-select tree state. Click semantics mirror Finder / VS Code
    // (and UXP `seltype="multiple"` on `molStructTree`):
    //   - plain click       -> replace with this id, set anchor here
    //   - Cmd/Ctrl+click    -> toggle this id in the set, set anchor here
    //   - Shift+click       -> select inclusive range between anchor and
    //                          this id (in visible-row order), replace
    //   - Shift+Cmd+click   -> select that range and add to existing
    const [selectedIds, setSelectedIds] = useState<Set<MolTreeId>>(() => new Set());
    // Anchor for Shift+click range select; null until the first single /
    // Cmd-click. Stays put on plain Shift+click extensions.
    const [anchorId, setAnchorId] = useState<MolTreeId | null>(null);
    // Expansion state lives in React, not Blueprint -- Tree is a stateless
    // controlled component when we set `isExpanded` explicitly.
    const [expandedIds, setExpandedIds] = useState<Set<MolTreeId>>(() => new Set());
    // Residue rows shown per chain name (RESIDUE_PAGE when absent).
    const [shownByChain, setShownByChain] = useState<Map<string, number>>(() => new Map());
    const shownOf = useCallback(
        (chainName: string) => shownByChain.get(chainName) ?? RESIDUE_PAGE,
        [shownByChain],
    );

    // Clear local selection / expansion whenever the active mol changes
    // (the lazy cache itself is cleared by the hook).
    useEffect(() => {
        setSelectedIds(new Set());
        setAnchorId(null);
        setExpandedIds(new Set());
        setShownByChain(new Map());
    }, [selectedMolId]);

    // Self-heal: any expanded chain/residue whose lazy cache is missing
    // should re-fetch. This covers (a) the brief window after mol switch
    // and (b) a future case where caches get invalidated by a topology
    // event -- without forcing the user to collapse-and-re-expand. The
    // hook dedupes inflight requests by key so this effect is safe to
    // fire on every render.
    useEffect(() => {
        for (const id of expandedIds) {
            if (id.startsWith('chain:')) {
                const chainName = id.slice('chain:'.length);
                if (chainName && !residuesByChain.has(chainName)) {
                    void loadResidues(chainName);
                }
            } else if (id.startsWith('resid:')) {
                const rest = id.slice('resid:'.length);
                const sep = rest.indexOf(':');
                if (sep > 0) {
                    const chainName = rest.slice(0, sep);
                    const residueIndex = rest.slice(sep + 1);
                    if (
                        chainName &&
                        residueIndex &&
                        !atomsByResidue.has(`${chainName}:${residueIndex}`)
                    ) {
                        void loadAtoms(chainName, residueIndex);
                    }
                }
            }
        }
    }, [expandedIds, residuesByChain, atomsByResidue, loadResidues, loadAtoms]);

    // Flat list of visible row ids in render order. Used by Shift+click
    // range selection. Placeholder rows ("Loading..." / "(no atoms)" /
    // "(no residues)") are excluded -- they're not selectable.
    const visibleRowIds = useMemo(() => {
        const ids: MolTreeId[] = [];
        for (const chain of chains) {
            const cid = encodeChainId(chain.name);
            ids.push(cid);
            if (!expandedIds.has(cid)) continue;
            const residues = residuesByChain.get(chain.name);
            if (!residues) continue; // children not loaded yet -> placeholder, skip
            for (const r of residues.slice(0, shownOf(chain.name))) {
                const rid = encodeResidueId(chain.name, r.index);
                ids.push(rid);
                if (!expandedIds.has(rid)) continue;
                const atoms = atomsByResidue.get(`${chain.name}:${r.index}`);
                if (!atoms) continue;
                for (const a of atoms) {
                    ids.push(encodeAtomId(chain.name, r.index, a.id));
                }
            }
        }
        return ids;
    }, [chains, expandedIds, residuesByChain, atomsByResidue, shownOf]);

    const handleNodeClick = useCallback(
        (node: TreeNodeInfo, _path: number[], e: React.MouseEvent<HTMLElement>) => {
            const id = String(node.id);
            // Ignore the disabled placeholder rows entirely -- they have no
            // selectable semantics. They are flagged via `disabled: true`
            // and their ids start with "loading-" or "empty-".
            if (node.disabled) return;

            if (e.shiftKey && anchorId !== null) {
                const a = visibleRowIds.indexOf(anchorId);
                const b = visibleRowIds.indexOf(id);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a <= b ? [a, b] : [b, a];
                    const rangeIds = visibleRowIds.slice(lo, hi + 1);
                    setSelectedIds((prev) => {
                        if (e.metaKey || e.ctrlKey) {
                            // Shift+Cmd: union the range with existing.
                            const next = new Set(prev);
                            for (const r of rangeIds) next.add(r);
                            return next;
                        }
                        return new Set(rangeIds);
                    });
                    // Anchor sticks across Shift extensions (Finder parity).
                    return;
                }
                // anchor or clicked id not in the visible set (rare --
                // e.g. anchor row got collapsed); fall through to a plain
                // click below.
            }

            if (e.metaKey || e.ctrlKey) {
                setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                });
                setAnchorId(id);
                return;
            }

            setSelectedIds(new Set([id]));
            setAnchorId(id);
        },
        [anchorId, visibleRowIds],
    );

    const handleNodeExpand = useCallback(
        (node: TreeNodeInfo) => {
            const id = String(node.id);
            setExpandedIds((prev) => {
                if (prev.has(id)) return prev;
                const next = new Set(prev);
                next.add(id);
                return next;
            });
            // Kick the lazy fetch -- useMolStructure dedupes inflight by key.
            if (id.startsWith("chain:")) {
                const chainName = id.slice("chain:".length);
                if (chainName) void loadResidues(chainName);
            } else if (id.startsWith("resid:")) {
                const rest = id.slice("resid:".length);
                const sep = rest.indexOf(":");
                if (sep > 0) {
                    const chainName = rest.slice(0, sep);
                    const residueIndex = rest.slice(sep + 1);
                    if (chainName && residueIndex) void loadAtoms(chainName, residueIndex);
                }
            }
        },
        [loadResidues, loadAtoms],
    );

    const handleNodeCollapse = useCallback((node: TreeNodeInfo) => {
        const id = String(node.id);
        setExpandedIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        // A chain opens again at its first page.
        if (id.startsWith("chain:")) {
            const chainName = id.slice("chain:".length);
            setShownByChain((prev) => {
                if (!prev.has(chainName)) return prev;
                const next = new Map(prev);
                next.delete(chainName);
                return next;
            });
        }
    }, []);

    // residueOrder map for selStrFromTree range merging.
    const residueOrder = useMemo<ReadonlyMap<string, readonly string[]>>(() => {
        const out = new Map<string, readonly string[]>();
        residuesByChain.forEach((residues, chainName) => {
            out.set(
                chainName,
                residues.map((r) => r.index),
            );
        });
        return out;
    }, [residuesByChain]);

    const buildAtomChildren = useCallback(
        (chainName: string, residueIndex: string): TreeNodeInfo[] | undefined => {
            const atoms = atomsByResidue.get(`${chainName}:${residueIndex}`);
            if (!atoms) {
                return [
                    {
                        id: `loading-atom:${chainName}:${residueIndex}`,
                        label: "Loading...",
                        icon: BLANK_ICON,
                        disabled: true,
                    },
                ];
            }
            if (atoms.length === 0) {
                return [
                    {
                        id: `empty-atom:${chainName}:${residueIndex}`,
                        label: "(no atoms)",
                        icon: BLANK_ICON,
                        disabled: true,
                    },
                ];
            }
            return atoms.map((atom) => {
                const id = encodeAtomId(chainName, residueIndex, atom.id);
                const label = atom.elem ? `${atom.name} (${atom.elem})` : atom.name;
                return {
                    id,
                    label,
                    icon: <AppIcon name="node.atom" aria-hidden />,
                    isSelected: selectedIds.has(id),
                };
            });
        },
        [atomsByResidue, selectedIds],
    );

    const buildResidueChildren = useCallback(
        (chainName: string): TreeNodeInfo[] | undefined => {
            const residues = residuesByChain.get(chainName);
            if (!residues) {
                return [
                    {
                        id: `loading-resid:${chainName}`,
                        label: "Loading...",
                        icon: BLANK_ICON,
                        disabled: true,
                    },
                ];
            }
            if (residues.length === 0) {
                return [
                    {
                        id: `empty-resid:${chainName}`,
                        label: "(no residues)",
                        icon: BLANK_ICON,
                        disabled: true,
                    },
                ];
            }
            const shown = shownOf(chainName);
            const rows: TreeNodeInfo[] = residues.slice(0, shown).map((r) => {
                const id = encodeResidueId(chainName, r.index);
                const label = `${r.index} ${r.name}`;
                const expanded = expandedIds.has(id);
                return {
                    id,
                    label,
                    icon: <AppIcon name="node.residue" aria-hidden />,
                    isSelected: selectedIds.has(id),
                    hasCaret: true,
                    isExpanded: expanded,
                    childNodes: expanded
                        ? buildAtomChildren(chainName, r.index)
                        : undefined,
                };
            });
            const rest = residues.length - shown;
            if (rest > 0) {
                rows.push({
                    id: `${MORE_PREFIX}${chainName}`,
                    label: (
                        <span data-more-chain={chainName} data-more-shown={shown}>
                            Loading more... ({rest} left)
                        </span>
                    ),
                    icon: BLANK_ICON,
                    disabled: true,
                });
            }
            return rows;
        },
        [residuesByChain, selectedIds, expandedIds, buildAtomChildren, shownOf],
    );

    const treeContents: TreeNodeInfo[] = useMemo(() => {
        return chains.map((chain) => {
            const id = encodeChainId(chain.name);
            const expanded = expandedIds.has(id);
            return {
                id,
                label: `chain "${chain.name}"`,
                icon: <AppIcon name="node.chain" aria-hidden />,
                isSelected: selectedIds.has(id),
                hasCaret: true,
                isExpanded: expanded,
                childNodes: expanded ? buildResidueChildren(chain.name) : undefined,
            };
        });
    }, [chains, selectedIds, expandedIds, buildResidueChildren]);

    // Add a chain's next page when its "Loading more..." row comes near the
    // visible area. The row carries the count it was drawn with, so a repeated
    // callback before the next render adds the page once.
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const root = scrollRef.current;
        if (!root || typeof IntersectionObserver === "undefined") return;
        const rows = root.querySelectorAll<HTMLElement>("[data-more-chain]");
        if (rows.length === 0) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const el = e.target as HTMLElement;
                    const chainName = el.dataset.moreChain ?? "";
                    const next = Number(el.dataset.moreShown) + RESIDUE_PAGE;
                    setShownByChain((prev) =>
                        (prev.get(chainName) ?? RESIDUE_PAGE) >= next ? prev : new Map(prev).set(chainName, next),
                    );
                }
            },
            { root, rootMargin: `0px 0px ${MORE_MARGIN_PX}px 0px` },
        );
        rows.forEach((r) => observer.observe(r));
        return () => observer.disconnect();
    }, [treeContents]);

    const hasSelection = selectedIds.size > 0;
    const hasView = activeMolViewId !== undefined;
    const canApply = hasSelection && selectedMolId !== undefined && activeSceneId !== undefined;

    const onSelect = useCallback(() => {
        if (!cm || !canApply) return;
        const selStr = selStrFromTree(selectedIds, residueOrder);
        if (!selStr) return;
        applyAndRecord(cm, "applyMolSelString", {
            sceneId: activeSceneId!,
            molId: selectedMolId!,
            selStr,
        });
    }, [cm, canApply, selectedIds, residueOrder, activeSceneId, selectedMolId]);

    const onCenter = useCallback(() => {
        if (!cm || !canApply || !hasView) return;
        const selStr = selStrFromTree(selectedIds, residueOrder);
        if (!selStr) return;
        applyAndRecord(cm, "selectAndFocusMol", {
            sceneId: activeSceneId!,
            viewId: activeMolViewId!,
            molId: selectedMolId!,
            selStr,
            zoom: false,
        });
    }, [cm, canApply, hasView, selectedIds, residueOrder, activeSceneId, activeMolViewId, selectedMolId]);

    const onZoom = useCallback(() => {
        if (!cm || !canApply || !hasView) return;
        const selStr = selStrFromTree(selectedIds, residueOrder);
        if (!selStr) return;
        applyAndRecord(cm, "selectAndFocusMol", {
            sceneId: activeSceneId!,
            viewId: activeMolViewId!,
            molId: selectedMolId!,
            selStr,
            zoom: true,
        });
    }, [cm, canApply, hasView, selectedIds, residueOrder, activeSceneId, activeMolViewId, selectedMolId]);

    // Properties shows exactly the one selected row. Not the anchor: it stays
    // on a row Cmd/Ctrl+click took out of the selection, and on the start of
    // a Shift range.
    const { showMolStruct } = useInspectorActions();
    const propPart =
        selectedIds.size === 1 ? decodeMolTreeId(selectedIds.values().next().value as MolTreeId) : null;
    const canShowProps = propPart !== null && selectedMolId !== undefined && activeSceneId !== undefined;
    const onProperties = useCallback(() => {
        if (!propPart || selectedMolId === undefined || activeSceneId === undefined) return;
        showMolStruct(activeSceneId, selectedMolId, propPart);
    }, [propPart, selectedMolId, activeSceneId, showMolStruct]);

    // Double-clicking a row shows its properties, as in the other tree panes
    // (scene tree, action history). The placeholder rows have nothing to show.
    const handleNodeDoubleClick = useCallback(
        (node: TreeNodeInfo) => {
            if (node.disabled || selectedMolId === undefined || activeSceneId === undefined) return;
            const part = decodeMolTreeId(String(node.id));
            if (part) showMolStruct(activeSceneId, selectedMolId, part);
        },
        [selectedMolId, activeSceneId, showMolStruct],
    );

    return (
        <div className="sp-pane">
            <PaneSectionHeader
                title="Mol Struct"
                icon="ui.git"
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                actions={
                    <ButtonGroup minimal>
                        <Tooltip content="Select atoms" placement="bottom">
                            <Button
                                minimal
                                small
                                icon={<AppIcon name="ui.select" aria-hidden />}
                                className="section-action-btn"
                                disabled={!canApply}
                                onClick={onSelect}
                            />
                        </Tooltip>
                        <Tooltip content="Center at" placement="bottom">
                            <Button
                                minimal
                                small
                                icon={<AppIcon name="ui.locate" aria-hidden />}
                                className="section-action-btn"
                                disabled={!canApply || !hasView}
                                onClick={onCenter}
                            />
                        </Tooltip>
                        <Tooltip content="Zoom at" placement="bottom">
                            <Button
                                minimal
                                small
                                icon={<AppIcon name="ui.zoomToFit" aria-hidden />}
                                className="section-action-btn"
                                disabled={!canApply || !hasView}
                                onClick={onZoom}
                            />
                        </Tooltip>
                        <Tooltip content="Properties" placement="bottom">
                            <Button
                                minimal
                                small
                                icon={<AppIcon name="ui.properties" aria-hidden />}
                                className="section-action-btn"
                                disabled={!canShowProps}
                                onClick={onProperties}
                            />
                        </Tooltip>
                    </ButtonGroup>
                }
            />
            {!collapsed && (
                <div className="sp-pane-fill">
                    <ObjectSelect
                        cm={cm}
                        sceneId={activeSceneId}
                        label="Molecule"
                        filter={objectFilters.molCoord}
                        selectedId={selectedMolId}
                        onChange={setSelectedMolId}
                        emptyText="(no molecules)"
                        fallbackName={(m) => `Mol ${m.uid}`}
                    />
                    <div ref={scrollRef} className="sp-pane-scroll mol-tree-scroll">
                        <ListboxTree
                            contents={treeContents}
                            onNodeClick={handleNodeClick}
                            onNodeDoubleClick={handleNodeDoubleClick}
                            onNodeExpand={handleNodeExpand}
                            onNodeCollapse={handleNodeCollapse}
                            className="mol-tree"
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
