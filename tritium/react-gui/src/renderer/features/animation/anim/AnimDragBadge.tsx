/**
 * @file features/animation/anim/AnimDragBadge.tsx
 * @description Floating readout of a strip's span while it is dragged.
 *
 * Shows the value the gesture changes -- the length for a resize, the start
 * for a move -- next to the edge being dragged, with the other end as a
 * secondary value. It is drawn on the timeline canvas rather than inside the
 * strip (the strip clips its content), above the strip's lane, or below it on
 * the first lane where the sticky ruler would cover it. The horizontal position
 * is clamped to the visible part of the scrolling timeline, so a strip at 0:00
 * or one dragged past either side of the view keeps a readable badge.
 */

import React, { useLayoutEffect, useRef } from "react";
import type { AnimStripEditMode } from "./AnimStrip";
import { formatClock, formatSpanSec, msToPx } from "./timelineGeometry";

interface AnimDragBadgeProps {
  mode: AnimStripEditMode;
  absStartMs: number;
  absEndMs: number;
  /** Index of the strip's lane (0 = the top lane). */
  laneIndex: number;
  pxPerMs: number;
}

/**
 * Render the drag readout for one strip.
 *
 * @param mode - The drag kind; picks the primary value and the anchor edge.
 * @param absStartMs - Previewed absolute start (ms).
 * @param absEndMs - Previewed absolute end (ms).
 */
export const AnimDragBadge: React.FC<AnimDragBadgeProps> = ({
  mode,
  absStartMs,
  absEndMs,
  laneIndex,
  pxPerMs,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const start = Math.max(0, absStartMs);
  const end = Math.max(start, absEndMs);
  const anchorPx = msToPx(mode === "resize-right" ? end : start, pxPerMs);

  // Centre on the dragged edge, then clamp into the visible scroll range.
  // Needs the badge's own width, so it is placed after layout (before paint:
  // no flicker).
  useLayoutEffect(() => {
    const node = ref.current;
    const view = node?.closest<HTMLElement>(".anim-timeline");
    if (!node || !view) return;
    const w = node.offsetWidth;
    const lo = view.scrollLeft;
    const hi = Math.max(lo, lo + view.clientWidth - w);
    node.style.left = `${Math.min(Math.max(lo, anchorPx - w / 2), hi)}px`;
  });

  const below = laneIndex === 0;
  const primary =
    mode === "move" ? `start ${formatClock(start)}` : `len ${formatSpanSec(end - start)}`;
  const secondary =
    mode === "resize-left" ? `start ${formatClock(start)}` : `end ${formatClock(end)}`;

  return (
    <div
      ref={ref}
      className={`anim-drag-badge type-caption${below ? " is-below" : ""}`}
      style={{ ["--anim-badge-lane" as string]: below ? 1 : laneIndex }}
      aria-hidden
    >
      <span className="anim-drag-badge-primary">{primary}</span>
      <span className="anim-drag-badge-secondary">{secondary}</span>
    </div>
  );
};
