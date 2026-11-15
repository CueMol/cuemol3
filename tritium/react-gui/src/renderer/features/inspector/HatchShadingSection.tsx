/**
 * @file features/inspector/HatchShadingSection.tsx
 * @description The "Shading" section of the NPR hatch layer editor: how the
 * lighting tone becomes an ink amount. Strength and Curve stay visible (the
 * two knobs that matter day to day); the rest of the tone recipe and the
 * ink-model extras sit under a collapsed Advanced area.
 */

import React from "react";

import { AccordionSection, FlatSection } from "./AccordionSection";
import { Field, SwitchField } from "@renderer/h3-kit/form";
import { HatchNumField } from "./HatchNumField";
import {
  INK_FIELDS,
  TONE_FIELDS,
  inkFieldEnabled,
  toneFieldEnabled,
  type HatchFieldDef,
  type HatchFieldEnv,
  type HatchInk,
  type HatchTone,
} from "@renderer/data/hatchSpec";

export interface HatchShadingSectionProps {
  tone: HatchTone;
  ink: HatchInk;
  /** What the other render settings make ineffective (shown disabled). */
  env: HatchFieldEnv;
  onToneChange: (patch: Partial<HatchTone>) => void;
  onInkChange: (patch: Partial<HatchInk>) => void;
}

const renderField = (
  f: HatchFieldDef,
  value: unknown,
  enabled: boolean,
  commit: (patch: Record<string, unknown>) => void,
): React.ReactNode => {
  if (f.type === "str") return null;
  if (f.type === "bool") {
    return (
      <Field key={f.key} label={f.label} inline>
        <SwitchField
          checked={Boolean(value)}
          disabled={!enabled}
          onChange={(v) => commit({ [f.key]: v })}
        />
      </Field>
    );
  }
  return (
    <HatchNumField
      key={f.key}
      field={f}
      value={Number(value)}
      disabled={!enabled}
      onCommit={(v) => commit({ [f.key]: v })}
    />
  );
};

export const HatchShadingSection: React.FC<HatchShadingSectionProps> = ({
  tone,
  ink,
  env,
  onToneChange,
  onInkChange,
}) => {
  const toneRec = tone as unknown as Record<string, unknown>;
  const inkRec = ink as unknown as Record<string, unknown>;
  const commitTone = (p: Record<string, unknown>) => onToneChange(p as Partial<HatchTone>);
  const commitInk = (p: Record<string, unknown>) => onInkChange(p as Partial<HatchInk>);
  return (
    <FlatSection title="Shading">
      {TONE_FIELDS.filter((f) => f.place === "primary").map((f) =>
        renderField(f, toneRec[f.key], toneFieldEnabled(f.key, tone, env), commitTone),
      )}
      <AccordionSection title="Advanced">
        {TONE_FIELDS.filter((f) => f.place === "advanced").map((f) =>
          renderField(f, toneRec[f.key], toneFieldEnabled(f.key, tone, env), commitTone),
        )}
        {INK_FIELDS.map((f) =>
          renderField(f, inkRec[f.key], inkFieldEnabled(f.key, ink, env), commitInk),
        )}
      </AccordionSection>
    </FlatSection>
  );
};
