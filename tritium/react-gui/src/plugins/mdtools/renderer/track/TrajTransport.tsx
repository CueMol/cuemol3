/**
 * @file plugins/mdtools/renderer/track/TrajTransport.tsx
 * @description Trajectory pane header: playback transport, frame readout /
 * spinbox, loop + speed, and zoom.
 *
 * Playback is driven by a JS timer in `useTrajPlayback` (a Trajectory has no
 * C++ playback engine). Controls are disabled when there is no selected
 * trajectory with frames (`canControl` false). The zoom / fit controls are
 * pure view state and always functional.
 *
 * The row never wraps, as the Animation panel's header does not: when the
 * pane is too narrow, the optional groups (loop / speed, zoom, frame) move
 * one by one into a trailing "more" popover (`usePriorityOverflow`). The
 * target selector and the playback buttons always stay.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Popover } from '@blueprintjs/core';
import { AppIcon } from '@renderer/h3-kit/primitives';
import { ButtonRow, Field, FormButton, SwitchField, SelectField, NumericField } from '@renderer/h3-kit/form';
import { usePriorityOverflow } from '@renderer/hooks/react/usePriorityOverflow';

interface TrajTransportProps {
    /** Rendered at the far left of the row (the target-object selector). */
    leftSlot?: React.ReactNode;
    frame: number;
    nframe: number;
    isPlaying: boolean;
    canControl: boolean;
    loop: boolean;
    fps: number;
    onPlayPause: () => void;
    onStop: () => void;
    onSkipStart: () => void;
    onSkipEnd: () => void;
    onToggleLoop: (loop: boolean) => void;
    onSetFps: (fps: number) => void;
    /** Commit a frame typed into the spinbox. */
    onCommitFrame: (frame: number) => void;
    onFit: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
}

/**
 * Optional header groups, first to move into the "more" menu first when the
 * pane is too narrow.
 */
const HIDE_ORDER = ['playback', 'zoom', 'frame'] as const;
type OverflowKey = (typeof HIDE_ORDER)[number];

/** Selectable playback rates (frames per second). */
const FPS_OPTIONS = [1, 2, 5, 10, 15, 24, 30, 60];

/**
 * Render the transport / frame-readout / loop+speed / zoom header row.
 */
export const TrajTransport: React.FC<TrajTransportProps> = ({
    leftSlot,
    frame,
    nframe,
    isPlaying,
    canControl,
    loop,
    fps,
    onPlayPause,
    onStop,
    onSkipStart,
    onSkipEnd,
    onToggleLoop,
    onSetFps,
    onCommitFrame,
    onFit,
    onZoomIn,
    onZoomOut,
}) => {
    // Local draft so typing does not seek mid-entry; resyncs when the live
    // frame changes (e.g. during playback / scrub).
    const [draft, setDraft] = useState(frame);
    useEffect(() => setDraft(frame), [frame]);

    const lastFrame = Math.max(0, nframe - 1);

    const rowRef = useRef<HTMLDivElement>(null);
    const hidden = usePriorityOverflow(rowRef, HIDE_ORDER);
    const isHidden = (key: OverflowKey) => hidden.includes(key);

    const frameReadout = (
        <>
            <NumericField
                value={draft}
                onChange={setDraft}
                onRelease={onCommitFrame}
                min={0}
                max={lastFrame}
                step={1}
                slider={false}
                disabled={!canControl}
            />
            <span className="mdtraj-readout-sep">/</span>
            <span className="mdtraj-readout-value type-mono">{lastFrame}</span>
        </>
    );
    const loopSwitch = <SwitchField checked={loop} onChange={onToggleLoop} disabled={!canControl} />;
    const speedSelect = (
        <SelectField
            value={String(fps)}
            onChange={(v) => onSetFps(Number(v))}
            disabled={!canControl}
            fill={false}
            aria-label="Playback speed (fps)"
        >
            {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                    {f} fps
                </option>
            ))}
        </SelectField>
    );
    const zoomButtons = (
        <>
            <FormButton text="Fit" onClick={onFit} title="Fit track to width" />
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
        <div className="mdtraj-transport" ref={rowRef}>
            {leftSlot}
            <ButtonRow className="mdtraj-transport-playback">
                <FormButton
                    icon={<AppIcon name="media.skipBack" aria-hidden />}
                    onClick={onSkipStart}
                    disabled={!canControl}
                    title="Skip to start"
                />
                <FormButton
                    icon={<AppIcon name={isPlaying ? 'media.pause' : 'media.play'} aria-hidden />}
                    onClick={onPlayPause}
                    active={isPlaying}
                    intent={isPlaying ? 'warning' : 'success'}
                    disabled={!canControl}
                    title={isPlaying ? 'Pause' : 'Play'}
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
                    disabled={!canControl}
                    title="Skip to end"
                />
            </ButtonRow>

            {!isHidden('frame') && (
                <div className="mdtraj-readout" data-overflow-key="frame">
                    <span className="mdtraj-readout-label type-caption">Frame</span>
                    {frameReadout}
                </div>
            )}

            {!isHidden('playback') && (
                <div className="mdtraj-readout mdtraj-readout-meta" data-overflow-key="playback">
                    <span className="mdtraj-readout-label type-caption">Loop</span>
                    {loopSwitch}
                    <span className="mdtraj-readout-label type-caption">Speed</span>
                    {speedSelect}
                </div>
            )}

            {!isHidden('zoom') && (
                <div className="mdtraj-zoom" data-overflow-key="zoom">
                    <ButtonRow>{zoomButtons}</ButtonRow>
                </div>
            )}

            {hidden.length > 0 && (
                <div className="mdtraj-overflow" data-overflow-more>
                    <Popover
                        placement="bottom-end"
                        content={
                            <div className="mdtraj-overflow-menu">
                                {isHidden('frame') && (
                                    <Field label="Frame">
                                        <div className="mdtraj-readout">{frameReadout}</div>
                                    </Field>
                                )}
                                {isHidden('playback') && (
                                    <>
                                        <Field label="Loop" inline>
                                            {loopSwitch}
                                        </Field>
                                        <Field label="Speed" inline>
                                            {speedSelect}
                                        </Field>
                                    </>
                                )}
                                {isHidden('zoom') && (
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
