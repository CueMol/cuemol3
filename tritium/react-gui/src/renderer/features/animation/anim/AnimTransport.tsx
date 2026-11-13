/**
 * @file features/animation/anim/AnimTransport.tsx
 * @description Timeline header: playback transport, time readout, start camera,
 * loop, and zoom.
 *
 * Playback controls drive the C++ `AnimMgr` via the parent's transport hook.
 * They are disabled when there is no active view (`canControl` false). The
 * start-camera select is a manager property (no view needed) and the zoom / fit
 * controls are pure view state, so both stay functional regardless.
 *
 * The current time is an editable `TimeField` on the ruler's scrub contract:
 * a gesture (drag, keys, stepper, Ctrl+wheel, a typed timecode) previews the
 * playhead locally and seeks once when it ends, so a long timeline is not
 * re-seeked per mouse move. The length beside it stays read-only: it is a
 * value the manager derives from its elements.
 *
 * The row never wraps. When the panel is too narrow, the optional groups
 * (element count / FPS, loop, start camera, zoom, time) move one by one into a
 * trailing "more" popover (`usePriorityOverflow`), so every control stays
 * reachable at any width.
 */

import React, { useRef } from "react";
import { Popover } from "@blueprintjs/core";
import { AppIcon } from "@renderer/h3-kit/primitives";
import { ButtonRow, Field, FormButton, SwitchField, SelectField, TimeField } from "@renderer/h3-kit/form";
import type { AnimMgrState } from "@renderer/types";
import { formatClock } from "./timelineGeometry";
import { usePriorityOverflow } from "./usePriorityOverflow";

/**
 * Optional header groups, first to move into the "more" menu first when the
 * panel is too narrow. The playback buttons always stay.
 */
const HIDE_ORDER = ["meta", "loop", "startcam", "zoom", "time"] as const;
type OverflowKey = (typeof HIDE_ORDER)[number];

interface AnimTransportProps {
  mgr: AnimMgrState;
  fps: number;
  elementCount: number;
  /** Whether playback is currently running. */
  isPlaying: boolean;
  /** Whether transport can act (cm + scene + active view present). */
  canControl: boolean;
  /**
   * Why playback is refused right now (the time-reference chain does not
   * resolve). Disables Play / skip / seek and the current-time field with
   * the reason as their tooltip; Stop, Loop, the start camera and zoom stay
   * live.
   */
  blockedReason?: string;
  loop: boolean;
  /** Scene camera names offered by the start-camera select. */
  cameras: string[];
  /** Time shown in the current-time field: the scrub preview, else `mgr.elapsedMs`. */
  playheadMs: number;
  /** Current-time field gesture: preview locally, seek once on release, drop on cancel. */
  onScrubPreview: (ms: number) => void;
  onScrubCommit: (ms: number) => void;
  onScrubCancel: () => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSkipStart: () => void;
  onSkipEnd: () => void;
  onToggleLoop: (loop: boolean) => void;
  /** Set `AnimMgr.startcam` ('' = none). */
  onStartCamChange: (name: string) => void;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * Render the transport / readout / start-cam / loop / zoom header row.
 */
export const AnimTransport: React.FC<AnimTransportProps> = ({
  mgr,
  fps,
  elementCount,
  isPlaying,
  canControl,
  blockedReason,
  loop,
  cameras,
  playheadMs,
  onScrubPreview,
  onScrubCommit,
  onScrubCancel,
  onPlayPause,
  onStop,
  onSkipStart,
  onSkipEnd,
  onToggleLoop,
  onStartCamChange,
  onFit,
  onZoomIn,
  onZoomOut,
}) => {
  const seekOff = !canControl || blockedReason !== undefined;
  const seekTitle = (title: string) => blockedReason ?? title;

  const rowRef = useRef<HTMLDivElement>(null);
  const hidden = usePriorityOverflow(rowRef, HIDE_ORDER);
  const isHidden = (key: OverflowKey) => hidden.includes(key);

  const startCam = (
    <SelectField
      value={cameras.includes(mgr.startcam) ? mgr.startcam : ""}
      onChange={onStartCamChange}
      aria-label="Start camera"
    >
      <option value="">(none)</option>
      {cameras.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </SelectField>
  );
  const timeReadout = (
    <>
      <TimeField
        value={playheadMs}
        min={0}
        max={mgr.lengthMs}
        onChange={onScrubPreview}
        onRelease={onScrubCommit}
        onDragCancel={onScrubCancel}
        disabled={seekOff}
        title={blockedReason}
        aria-label="Current time"
      />
      <span className="anim-readout-sep">/</span>
      <span className="anim-readout-value type-mono">{formatClock(mgr.lengthMs)}</span>
    </>
  );
  const loopSwitch = <SwitchField checked={loop} onChange={onToggleLoop} disabled={!canControl} />;
  const zoomButtons = (
    <>
      <FormButton text="Fit" onClick={onFit} title="Fit timeline to width" />
      <FormButton
        icon={<AppIcon name="ui.remove" aria-hidden />}
        onClick={onZoomOut}
        title="Zoom out"
      />
      <FormButton
        icon={<AppIcon name="ui.add" aria-hidden />}
        onClick={onZoomIn}
        title="Zoom in"
      />
    </>
  );

  return (
  <div className="anim-transport" ref={rowRef}>
    <ButtonRow className="anim-transport-playback">
      <FormButton
        icon={<AppIcon name="media.skipBack" aria-hidden />}
        onClick={onSkipStart}
        disabled={seekOff}
        title={seekTitle("Skip to start")}
      />
      <FormButton
        icon={<AppIcon name={isPlaying ? "media.pause" : "media.play"} aria-hidden />}
        onClick={onPlayPause}
        active={isPlaying}
        intent={isPlaying ? "warning" : "success"}
        disabled={seekOff}
        title={seekTitle(isPlaying ? "Pause" : "Play")}
      />
      <FormButton
        icon={<AppIcon name="media.stop" aria-hidden />}
        onClick={onStop}
        disabled={!canControl}
        title="Stop"
      />
      <FormButton
        icon={<AppIcon name="media.skipForward" aria-hidden />}
        onClick={onSkipEnd}
        disabled={seekOff}
        title={seekTitle("Skip to end")}
      />
    </ButtonRow>

    {!isHidden("time") && (
      <div className="anim-readout" data-overflow-key="time">
        {timeReadout}
      </div>
    )}

    {!isHidden("startcam") && (
      <div className="anim-readout anim-startcam" data-overflow-key="startcam">
        <span className="anim-readout-label type-caption">Start cam</span>
        {startCam}
      </div>
    )}

    {!isHidden("loop") && (
      <div className="anim-readout" data-overflow-key="loop">
        <span className="anim-readout-label type-caption">Loop</span>
        {loopSwitch}
      </div>
    )}

    {!isHidden("meta") && (
      <div className="anim-readout" data-overflow-key="meta">
        <span className="anim-readout-label type-caption">Elements</span>
        <span className="anim-readout-value type-mono">{elementCount}</span>
        <span className="anim-readout-label type-caption">FPS</span>
        <span className="anim-readout-value type-mono">{fps}</span>
      </div>
    )}

    {!isHidden("zoom") && (
      <div className="anim-zoom" data-overflow-key="zoom">
        <ButtonRow>{zoomButtons}</ButtonRow>
      </div>
    )}

    {hidden.length > 0 && (
      <div className="anim-overflow" data-overflow-more>
        <Popover
          placement="bottom-end"
          content={
            <div className="anim-overflow-menu">
              {isHidden("time") && (
                <Field label="Time">
                  <div className="anim-readout">{timeReadout}</div>
                </Field>
              )}
              {isHidden("startcam") && <Field label="Start cam">{startCam}</Field>}
              {isHidden("loop") && (
                <Field label="Loop" inline>
                  {loopSwitch}
                </Field>
              )}
              {isHidden("meta") && (
                <>
                  <Field label="Elements" inline>
                    <span className="anim-readout-value type-mono">{elementCount}</span>
                  </Field>
                  <Field label="FPS" inline>
                    <span className="anim-readout-value type-mono">{fps}</span>
                  </Field>
                </>
              )}
              {isHidden("zoom") && (
                <Field label="Zoom" inline>
                  <ButtonRow>{zoomButtons}</ButtonRow>
                </Field>
              )}
            </div>
          }
        >
          <FormButton icon={<AppIcon name="ui.more" aria-hidden />} title="More" />
        </Popover>
      </div>
    )}
  </div>
  );
};
