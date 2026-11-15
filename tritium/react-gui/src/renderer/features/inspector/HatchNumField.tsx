/**
 * @file features/inspector/HatchNumField.tsx
 * @description One numeric row of the NPR hatch editor, drawn from its spec
 * field: the label and a drag number box spanning the rest of the row. The
 * spec's min / max bound it and its step is the drag snap and arrow increment;
 * the value is written once, when the interaction ends.
 */

import React, { useEffect, useState } from "react";

import { DragNumericField, Field } from "@renderer/h3-kit/form";
import type { HatchFieldDef } from "@renderer/data/hatchSpec";

export interface HatchNumFieldProps {
  field: HatchFieldDef;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}

/** Decimals of a step (0.25 -> 2, 1 -> 0): the value never has more. */
const stepDecimals = (step: number | undefined): number => {
  const t = String(step ?? 1);
  const dot = t.indexOf(".");
  return dot < 0 ? 0 : t.length - dot - 1;
};

export const HatchNumField: React.FC<HatchNumFieldProps> = ({ field: f, value, disabled, onCommit }) => {
  // The box shows the in-progress value; the spec is written on release.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <Field label={f.label} inline fill>
      <DragNumericField
        value={draft}
        onChange={setDraft}
        onRelease={(v) => {
          if (v !== value) onCommit(v);
        }}
        min={f.min}
        max={f.max}
        step={f.step}
        unit={f.unit}
        decimals={stepDecimals(f.step)}
        disabled={disabled}
      />
    </Field>
  );
};
