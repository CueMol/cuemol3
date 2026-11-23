/**
 * @file features/render/MovieSettingsPanel.tsx
 * @description Movie output settings -- the "Movie" section of the Rendering
 * window's Image tab (RenderImageTab), shown while the render mode is "movie".
 *
 * These settings belong to the render *mode*, not to a backend: they apply
 * unchanged to POV-Ray and Umbreon alike. Keeping them out of the Render tab
 * keeps that tab to the backend-driven groups, and a hand-written panel does
 * things the generic PropDef editor cannot -- a folder picker, and disabling
 * the format / rate controls while encoding is off or the format ignores them.
 */

import React, { useCallback, useEffect, useState } from "react";

import {
  Field,
  FieldSection,
  TextField,
  SelectField,
  RadioField,
  SwitchField,
  ComboBoxField,
  FormButton,
} from "@renderer/h3-kit/form";
import { AppIcon } from "@renderer/h3-kit/primitives";
import {
  MOVIE_FORMAT_IDS,
  MOVIE_FORMAT_LABEL,
  MOVIE_FPS_PRESETS,
  MOVIE_BITRATE_PRESETS,
  MOVIE_FORMAT_RATE,
  MOVIE_QUALITY_IDS,
  MOVIE_QUALITY_LABEL,
  type MovieSettings,
  type MovieFormatId,
  type MovieQuality,
  type MovieRateControl,
} from "@renderer/data/renderSettings";

/** Where the output goes: the app-managed folder, or one the user names. */
type LocationMode = "temp" | "custom";

const LOCATION_OPTIONS = [
  { label: "Temporary", value: "temp" as const },
  { label: "Custom", value: "custom" as const },
];

const RATE_CONTROL_OPTIONS = [
  { label: "Quality", value: "quality" as const },
  { label: "Bit rate", value: "bitrate" as const },
];

interface MovieSettingsPanelProps {
  /** Section heading for this column. */
  title: string;
  /** Current movie settings. */
  settings: MovieSettings;
  /** Apply a partial change. */
  onChange: (patch: Partial<MovieSettings>) => void;
  /** Switch the output back to the app-managed folder. */
  onUseTempDir?: () => void;
  /** Leave the app-managed folder for one the user names. */
  onUseCustomDir?: () => void;
  /** Open a folder picker. Omit to hide the browse button. */
  onPickFolder?: () => void;
  /** Disable every control (a render is in flight). */
  disabled?: boolean;
}

/** Parse a positive number, or undefined when the text is not one. */
function positiveNumber(text: string): number | undefined {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const MovieSettingsPanel: React.FC<MovieSettingsPanelProps> = ({
  title,
  settings,
  onChange,
  onUseTempDir,
  onUseCustomDir,
  onPickFolder,
  disabled = false,
}) => {
  // Numeric fields keep a draft string so an intermediate empty value while
  // editing (e.g. after deleting the last digit) is not snapped back by the
  // committed number. The draft re-syncs whenever the committed value changes.
  const [fpsDraft, setFpsDraft] = useState(String(settings.fps));
  const [bitrateDraft, setBitrateDraft] = useState(String(settings.bitrateKbps));
  useEffect(() => setFpsDraft(String(settings.fps)), [settings.fps]);
  useEffect(() => setBitrateDraft(String(settings.bitrateKbps)), [settings.bitrateKbps]);

  const handleFps = useCallback(
    (text: string) => {
      setFpsDraft(text);
      const fps = positiveNumber(text);
      if (fps !== undefined) onChange({ fps });
    },
    [onChange],
  );

  const handleBitrate = useCallback(
    (text: string) => {
      setBitrateDraft(text);
      const bitrateKbps = positiveNumber(text);
      if (bitrateKbps !== undefined) onChange({ bitrateKbps });
    },
    [onChange],
  );

  // Encoding options only matter when a movie is actually produced.
  const encodeDisabled = disabled || !settings.makeMovie;
  // Which rate controls the chosen format takes (see MOVIE_FORMAT_RATE): the
  // H.264 / H.265 formats choose between a quality level and a bit rate,
  // WMV2 takes a bit rate only, the uncompressed and GIF formats neither.
  const rateSupport = MOVIE_FORMAT_RATE[settings.movieFormat];
  const rateControl: MovieRateControl =
    rateSupport === "crf" ? settings.rateControl : "bitrate";
  const qualityDisabled = encodeDisabled || rateSupport !== "crf" || rateControl !== "quality";
  const bitrateDisabled = encodeDisabled || rateSupport === "none" || rateControl !== "bitrate";

  // A radio group, not a segmented control: this is a setting with two named
  // alternatives, and a segmented control inside a settings section reads as a
  // second row of tabs under the pane's Image / Render strip. Picking Custom
  // only leaves the app-managed folder -- the browse button below is what
  // actually names one -- so choosing a location never pops a dialog.
  const handleLocation = useCallback(
    (mode: LocationMode) => {
      if (mode === "temp") onUseTempDir?.();
      else onUseCustomDir?.();
    },
    [onUseTempDir, onUseCustomDir],
  );

  return (
    <div className="movie-settings-panel">
      <FieldSection title={title}>
        <Field label="Location">
          <RadioField<LocationMode>
            value={settings.useTempDir ? "temp" : "custom"}
            onValueChange={handleLocation}
            options={LOCATION_OPTIONS}
            disabled={disabled}
          />
        </Field>

        <Field label="Folder">
          <TextField
            value={settings.outputDir}
            onChange={(outputDir) => onChange({ outputDir })}
            placeholder="Choose a folder for the rendered frames"
            disabled={disabled}
            // The app owns the temporary folder, so it is shown but not typed
            // into; picking a folder is what leaves it.
            readOnly={settings.useTempDir}
            invalid={!settings.useTempDir && settings.outputDir.trim() === ""}
            rightElement={
              onPickFolder && (
                <FormButton
                  minimal
                  icon={<AppIcon name="ui.folder" aria-hidden />}
                  aria-label="Choose output folder"
                  onClick={onPickFolder}
                  disabled={disabled}
                />
              )
            }
          />
        </Field>

        {settings.useTempDir && (
          <div className="movie-settings-hint type-caption">
            Temporary folder: the frames are removed a day after the render and
            the movie after a month. Use Save movie as... to keep it.
          </div>
        )}

        <Field label="Base name">
          <TextField
            value={settings.baseName}
            onChange={(baseName) => onChange({ baseName })}
            placeholder="movie"
            disabled={disabled}
          />
        </Field>

        <Field label="Frame rate">
          <ComboBoxField
            value={fpsDraft}
            onChange={handleFps}
            options={MOVIE_FPS_PRESETS.map(String)}
            disabled={disabled}
          />
        </Field>

        <Field label="Encode movie" inline>
          <SwitchField
            checked={settings.makeMovie}
            onChange={(makeMovie) => onChange({ makeMovie })}
            disabled={disabled}
          />
        </Field>

        <Field label="Format">
          <SelectField
            value={settings.movieFormat}
            onChange={(v) => onChange({ movieFormat: v as MovieFormatId })}
            disabled={encodeDisabled}
          >
            {MOVIE_FORMAT_IDS.map((id) => (
              <option key={id} value={id}>
                {MOVIE_FORMAT_LABEL[id]}
              </option>
            ))}
          </SelectField>
        </Field>

        <Field label="Rate control">
          <RadioField<MovieRateControl>
            value={rateControl}
            onValueChange={(v) => onChange({ rateControl: v })}
            options={RATE_CONTROL_OPTIONS}
            disabled={encodeDisabled || rateSupport !== "crf"}
          />
        </Field>

        <Field label="Quality">
          <SelectField
            value={settings.quality}
            onChange={(v) => onChange({ quality: v as MovieQuality })}
            disabled={qualityDisabled}
          >
            {MOVIE_QUALITY_IDS.map((id) => (
              <option key={id} value={id}>
                {MOVIE_QUALITY_LABEL[id]}
              </option>
            ))}
          </SelectField>
        </Field>

        <Field label="Bit rate (kbps)">
          <ComboBoxField
            value={bitrateDraft}
            onChange={handleBitrate}
            options={MOVIE_BITRATE_PRESETS.map(String)}
            disabled={bitrateDisabled}
          />
        </Field>

        <Field label="Render last frame" inline>
          <SwitchField
            checked={settings.dupLastFrame}
            onChange={(dupLastFrame) => onChange({ dupLastFrame })}
            disabled={disabled}
          />
        </Field>
      </FieldSection>
    </div>
  );
};
