/**
 * @file h3-kit/primitives/extIcons.tsx
 * @description Icons taken from other outline sets for glyphs Phosphor does
 * not have, drawn so they sit with Phosphor: a 24-unit outline with round caps
 * and joins, whose stroke follows the Phosphor weight (`regular` is 1.5 px at
 * 24 px, the width of a Phosphor regular stroke).
 *
 * Tabler Icons (https://tabler.io/icons), `file-import` and `file-export`:
 *
 *   MIT License
 *
 *   Copyright (c) 2020-2024 Pawel Kuna
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit
 *   persons to whom the Software is furnished to do so, subject to the
 *   following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *   NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import React from "react";
import type { IconWeight } from "@phosphor-icons/react";

export interface ExtIconProps {
  size: number;
  weight: IconWeight;
  className?: string;
  "aria-hidden"?: boolean;
  title?: string;
}

export type ExtIcon = React.FC<ExtIconProps>;

/**
 * Stroke width (24-unit box) matching each Phosphor weight: Phosphor draws on
 * a 256 box, so its 16-unit regular stroke is 1.5 here. Fill / duotone have
 * no outline equivalent and use the regular stroke.
 */
const STROKE: Record<IconWeight, number> = {
  thin: 0.75,
  light: 1.125,
  regular: 1.5,
  bold: 2.25,
  fill: 1.5,
  duotone: 1.5,
};

/** Build an outline icon from 24-unit path data. */
function outlineIcon(paths: readonly string[]): ExtIcon {
  const Icon: ExtIcon = ({ size, weight, title, ...rest }) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[weight]}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {title && <title>{title}</title>}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
  return Icon;
}

/** Tabler `file-import`: an arrow entering a page (load into the scene). */
export const TablerFileImport = outlineIcon([
  "M14 3v4a1 1 0 0 0 1 1h4",
  "M5 13v-8a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-5.5m-9.5 -2h7m-3 -3l3 3l-3 3",
]);

/** Tabler `file-export`: an arrow leaving a page (write one object out). */
export const TablerFileExport = outlineIcon([
  "M14 3v4a1 1 0 0 0 1 1h4",
  "M11.5 21h-4.5a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v5m-5 6h7m-3 -3l3 3l-3 3",
]);
