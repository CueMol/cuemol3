/**
 * @file features/animation/anim/usePriorityOverflow.ts
 * @description Priority+ overflow for a single-line toolbar: decides which
 * optional groups no longer fit and should move into a trailing "more" menu.
 *
 * The toolbar marks each optional group with `data-overflow-key="<key>"` and
 * the "more" button with `data-overflow-more`; every other child is always
 * shown. Groups are hidden in the order given by `hideOrder` (first = first to
 * go) until the row fits. A group's width is remembered from the last time it
 * was on screen, so a hidden group can be put back as soon as there is room
 * for it again. The "more" button's width counts only while something is
 * hidden; before it has been seen, the first button in the row stands in.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Track which optional toolbar groups overflow the container.
 *
 * @param ref - The toolbar container (a single-line flex row).
 * @param hideOrder - Group keys, first to be hidden first.
 * @returns The keys of the groups that do not fit, in `hideOrder` order.
 */
export function usePriorityOverflow(
  ref: React.RefObject<HTMLElement | null>,
  hideOrder: readonly string[],
): string[] {
  const [hidden, setHidden] = useState<string[]>([]);
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef<number | null>(null);
  const orderRef = useRef(hideOrder);
  orderRef.current = hideOrder;

  const measure = useCallback(() => {
    const el = ref.current;
    // Not laid out (a hidden tab, or jsdom): nothing to measure, so keep the
    // current choice instead of hiding everything.
    if (!el || el.clientWidth === 0) return;
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const avail = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);

    let fixed = 0;
    let fixedCount = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      if (child.dataset.overflowMore !== undefined) {
        moreWidth.current = child.offsetWidth;
        continue;
      }
      const key = child.dataset.overflowKey;
      if (key !== undefined) {
        widths.current.set(key, child.offsetWidth);
        continue;
      }
      fixed += child.offsetWidth;
      fixedCount += 1;
    }
    const more =
      moreWidth.current ??
      (el.querySelector<HTMLElement>(".bp5-button")?.offsetWidth || 0);

    const order = orderRef.current;
    const shown = order.filter((k) => widths.current.has(k));
    let count = fixedCount + shown.length;
    let total = fixed + shown.reduce((s, k) => s + (widths.current.get(k) ?? 0), 0);
    const next: string[] = [];
    const fits = (): boolean => {
      const n = count + (next.length > 0 ? 1 : 0);
      const w = total + (next.length > 0 ? more : 0);
      return w + gap * Math.max(0, n - 1) <= avail;
    };
    for (const key of shown) {
      if (fits()) break;
      next.push(key);
      total -= widths.current.get(key) ?? 0;
      count -= 1;
    }

    setHidden((prev) => (prev.join("\n") === next.join("\n") ? prev : next));
  }, [ref]);

  // Re-measure after every render (contents such as a counter can change
  // width) and whenever the container is resized.
  useLayoutEffect(() => {
    measure();
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, measure]);

  return hidden;
}
