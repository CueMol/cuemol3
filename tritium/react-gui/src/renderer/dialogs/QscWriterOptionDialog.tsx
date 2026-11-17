import React, { useEffect, useState } from 'react';
import { FormGroup, HTMLSelect, Switch } from '@blueprintjs/core';
import { DialogShell } from './DialogShell';

export type QscVersion = 'QDF0' | 'QDF1';
export type QscCompress = 'xzip' | 'gzip' | 'none';

/** The oldest app version the file is written for (the writer's `compat`). */
export type QscCompat = '2.2' | '2.3' | '3.0';

export interface QscWriterOptions {
    embedAll: boolean;
    version: QscVersion;
    /**
     * 3.0 refers to an application style file (the scene's `cuemol3_look`)
     * as `%%CONFDIR%%/...`; an older target embeds its contents.
     */
    compat: QscCompat;
    compress: QscCompress;
    base64: boolean;
}

interface Props {
    visible: boolean;
    onConfirm: (result: QscWriterOptions) => void;
    onCancel: () => void;
}

const COMPAT_OPTIONS: { value: QscCompat; label: string }[] = [
    { value: '3.0', label: 'Ver 3.0 or later' },
    { value: '2.3', label: 'Ver 2.3 or later' },
    { value: '2.2', label: 'Ver 2.2 or later' },
];

/** The data format (QDF version) a compatibility target writes. */
function versionOf(compat: QscCompat): QscVersion {
    return compat === '2.2' ? 'QDF0' : 'QDF1';
}

const COMPRESS_OPTIONS: { value: QscCompress; label: string }[] = [
    { value: 'xzip', label: 'xz' },
    { value: 'gzip', label: 'gzip' },
    { value: 'none', label: 'none' },
];

export function QscWriterOptionDialog({ visible, onConfirm, onCancel }: Props): React.JSX.Element {

    const [embedAll, setEmbedAll] = useState(false);
    const [compat, setCompat] = useState<QscCompat>('3.0');
    const [compress, setCompress] = useState<QscCompress>('xzip');
    const [base64, setBase64] = useState(false);

    useEffect(() => {
        if (visible) {
            // Defaults: Ver 3.0 (QDF1) + embed off + base64 off + xz.
            //
            // UXP qscwriter-option-dlg.js onLoad picks QDF0 ("default: qdf0
            // (compat)"), which predates QDF1 being the established format --
            // and because QDF0 has no notion of compression, that default also
            // silently forces compress=none at OK time, so scenes saved
            // straight through the dialog were never compressed. QDF1 is the
            // default here instead, which leaves the compression option live
            // and lands on xz. Everything else, including the QDF0 disable
            // rule enforced at OK time (see handleOk), stays UXP-faithful.
            // Ver 3.0 is QDF1 that may refer to CueMol3's own style files.
            setEmbedAll(false);
            setCompat('3.0');
            setCompress('xzip');
            setBase64(false);
        }
    }, [visible]);

    const version = versionOf(compat);
    const advancedDisabled = version === 'QDF0';

    const handleOk = (): void => {
        // UXP parity (qscwriter-option-dlg.js onDialogAccept): QDF0 has no
        // notion of compression / text encoding, so coerce them at submit
        // time regardless of the (disabled) UI state.
        if (advancedDisabled) {
            onConfirm({ embedAll, version, compat, compress: 'none', base64: false });
        } else {
            onConfirm({ embedAll, version, compat, compress, base64 });
        }
    };

    return (
        <DialogShell
            visible={visible}
            title="Scene options"
            width="md"
            onCancel={onCancel}
            onOk={handleOk}
        >
            <Switch
                label="Embed possible"
                checked={embedAll}
                onChange={(e) => setEmbedAll(e.currentTarget.checked)}
            />

            <fieldset style={{ marginTop: 8, padding: '8px 12px' }}>
                <legend style={{ padding: '0 4px' }}>Format</legend>

                <FormGroup label="Compatibility" inline>
                    <HTMLSelect
                        className="h3-form-select"
                        value={compat}
                        onChange={(e) => setCompat(e.currentTarget.value as QscCompat)}
                        options={COMPAT_OPTIONS}
                    />
                </FormGroup>

                <FormGroup label="Compression" inline disabled={advancedDisabled}>
                    <HTMLSelect
                        className="h3-form-select"
                        value={compress}
                        disabled={advancedDisabled}
                        onChange={(e) => setCompress(e.currentTarget.value as QscCompress)}
                        options={COMPRESS_OPTIONS}
                    />
                </FormGroup>

                <Switch
                    label="Enable text encoding"
                    checked={base64}
                    disabled={advancedDisabled}
                    onChange={(e) => setBase64(e.currentTarget.checked)}
                />
            </fieldset>
        </DialogShell>
    );
}
