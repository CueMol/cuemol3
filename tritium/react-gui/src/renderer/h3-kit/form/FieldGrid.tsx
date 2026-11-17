/**
 * @file h3-kit/form/FieldGrid.tsx
 * @description Aligned label+control layout: a grid whose rows share one
 * label-column width, so every control's left edge lines up (Blender-style
 * property rows). Use this instead of a stack of inline `Field`s when several
 * rows should align into a tidy two-column block.
 *
 * `FieldGrid` is the grid container; each `FieldGridRow` contributes a label
 * cell and a control cell. Rows use `display: contents` so their label/control
 * become direct grid items of the container -- that is what lets the auto
 * label column size to the widest label and stay shared across rows. When the
 * container narrows past the control column's floor
 * (`--form-grid-control-min`) the shared label column truncates, so every row
 * ellipsises by the same amount instead of each finding its own width.
 *
 * Like the rest of the catalog these own layout only: sizing/spacing/typography
 * come from `.h3-form-grid*` in `styles/_form-kit.css`. No size props are exposed,
 * and controls (e.g. `DragNumericField`) need not know about the label column.
 *
 * @module form/FieldGrid
 */

import React from 'react';
import { Radio } from '@blueprintjs/core';

export interface FieldGridProps {
    /** Layout-only class for positioning the grid within its parent. */
    className?: string;
    children: React.ReactNode;
}

export const FieldGrid: React.FC<FieldGridProps> = ({ className, children }) => (
    <div className={`h3-form-grid${className ? ` ${className}` : ''}`}>{children}</div>
);

export interface FieldGridRowProps {
    /** Label shown in the (right-aligned) label column. */
    label: string;
    children: React.ReactNode;
}

export const FieldGridRow: React.FC<FieldGridRowProps> = ({ label, children }) => (
    <div className="h3-form-grid-row">
        <label className="h3-form-grid-label">{label}</label>
        <div className="h3-form-grid-control">{children}</div>
    </div>
);

export interface FieldGridRadioHeadingProps {
    /** Radio label. */
    label: string;
    /** Radio group name shared by the headings of one grid (keyboard grouping). */
    name: string;
    checked: boolean;
    onSelect: () => void;
    disabled?: boolean;
}

/**
 * A group heading that is itself a radio choice ("New Scene" / "New View"):
 * picking it picks the group, and the rows below it are that choice's options.
 * Spans both columns. In a grid that has radio headings, the row labels are
 * indented to the radio's text, so the options read as belonging to the
 * choice above them while every group still shares one label column.
 */
export const FieldGridRadioHeading: React.FC<FieldGridRadioHeadingProps> = ({
    label,
    name,
    checked,
    onSelect,
    disabled,
}) => (
    <div className="h3-form-grid-heading h3-form-grid-radio-heading h3-form-radio-group">
        <Radio
            name={name}
            label={label}
            checked={checked}
            disabled={disabled}
            onChange={() => onSelect()}
        />
    </div>
);
