/**
 * @file dialogs/NewTabDialog.tsx
 * @description The New Tab/Window dialog: a new scene (with its name and the
 * settings it starts with) or a new view of the current scene.
 *
 * Built from the form-kit catalog only: one `FieldGrid` whose groups are
 * headed by the mode radios (`FieldGridRadioHeading`), each followed by that
 * mode's options, indented under it. Every row shares one label column and one
 * row height, so the controls of both groups line up. Spacing comes from the
 * kit, not this file. The section of the mode not chosen stays visible but disabled.
 */

import React, { useState, useEffect } from 'react';
import { DialogShell } from './DialogShell';
import { NewSceneSettingsFields } from './NewSceneSettingsFields';
import type { NewSceneDefaults } from '@renderer/data/newSceneDefaults';
import {
    FieldGrid,
    FieldGridRadioHeading,
    FieldGridRow,
    FieldSection,
    SwitchField,
    TextField,
} from '@renderer/h3-kit/form';

export type NewTabMode = 'new-scene' | 'new-view';

export interface NewTabDialogResult {
    mode: NewTabMode;
    name: string;
    inheritViewProps: boolean;
    /** What the new scene should look like; only set for `new-scene`. */
    sceneDefaults?: NewSceneDefaults;
}

interface Props {
    visible: boolean;
    currentSceneName: string | null;
    defaultSceneName: string;
    defaultViewName: string;
    /** Scene settings to open with -- the values last confirmed here. */
    sceneDefaults: NewSceneDefaults;
    onConfirm: (result: NewTabDialogResult) => void;
    onCancel: () => void;
}

export function NewTabDialog({
    visible,
    currentSceneName,
    defaultSceneName,
    defaultViewName,
    sceneDefaults,
    onConfirm,
    onCancel,
}: Props): React.JSX.Element {

    const [mode, setMode] = useState<NewTabMode>('new-scene');
    const [sceneName, setSceneName] = useState(defaultSceneName);
    const [viewName, setViewName] = useState(defaultViewName);
    const [inherit, setInherit] = useState(true);
    const [scene, setScene] = useState<NewSceneDefaults>(sceneDefaults);

    // Reset state when dialog opens
    useEffect(() => {
        if (visible) {
            setMode('new-scene');
            setSceneName(defaultSceneName);
            setViewName(defaultViewName);
            setInherit(true);
            setScene(sceneDefaults);
        }
    }, [visible, defaultSceneName, defaultViewName, sceneDefaults]);

    const handleOk = () => {
        const name = mode === 'new-scene' ? sceneName.trim() : viewName.trim();
        onConfirm({
            mode,
            name: name || (mode === 'new-scene' ? defaultSceneName : defaultViewName),
            inheritViewProps: inherit,
            sceneDefaults: mode === 'new-scene' ? scene : undefined,
        });
    };

    const newViewLabel = currentSceneName
        ? `New View for ${currentSceneName}`
        : 'New View (no current scene)';

    return (
        <DialogShell
            visible={visible}
            title="New Tab/Window"
            width="lg"
            onCancel={onCancel}
            onOk={handleOk}
        >
            <FieldSection title="Create new tab for">
                <FieldGrid>
                    <FieldGridRadioHeading
                        name="new-tab-mode"
                        label="New Scene"
                        checked={mode === 'new-scene'}
                        onSelect={() => setMode('new-scene')}
                    />
                    <FieldGridRow label="Name">
                        <TextField
                            value={sceneName}
                            onChange={setSceneName}
                            disabled={mode !== 'new-scene'}
                        />
                    </FieldGridRow>
                    <NewSceneSettingsFields
                        value={scene}
                        onChange={setScene}
                        disabled={mode !== 'new-scene'}
                    />

                    <FieldGridRadioHeading
                        name="new-tab-mode"
                        label={newViewLabel}
                        checked={mode === 'new-view'}
                        disabled={!currentSceneName}
                        onSelect={() => setMode('new-view')}
                    />
                    <FieldGridRow label="Name">
                        <TextField
                            value={viewName}
                            onChange={setViewName}
                            disabled={mode !== 'new-view'}
                        />
                    </FieldGridRow>
                    <FieldGridRow label="Inherit view props">
                        <SwitchField
                            checked={inherit}
                            onChange={setInherit}
                            disabled={mode !== 'new-view'}
                        />
                    </FieldGridRow>
                </FieldGrid>
            </FieldSection>
        </DialogShell>
    );
}
