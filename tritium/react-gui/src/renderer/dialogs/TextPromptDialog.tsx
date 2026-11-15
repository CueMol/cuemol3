import React, { useEffect, useRef, useState } from 'react'
import { FormGroup, InputGroup } from '@blueprintjs/core'
import { DialogShell } from './DialogShell';
import { isImeKey } from '@renderer/h3-kit/form'

/**
 * Single-line text input dialog -- replacement for Electron's disabled
 * `window.prompt`. Used by ScenePane context-menu Rename / New Group
 * flows; intentionally generic so other "ask for a name" callsites
 * can reuse it.
 *
 * Resolves to the trimmed entered string on OK (Enter or button), or
 * `null` on Cancel / outside-close. Empty / whitespace-only input
 * disables OK to mirror UXP `util.prompt`; so does input `validate`
 * rejects, with its message shown under the field.
 */
interface Props {
    visible: boolean
    title: string
    label: string
    defaultValue: string
    confirmLabel?: string
    /** Why the trimmed input cannot be used, or null when it can. */
    validate?: (trimmed: string) => string | null
    onResult: (value: string | null) => void
}

export function TextPromptDialog({
    visible,
    title,
    label,
    defaultValue,
    confirmLabel,
    validate,
    onResult,
}: Props): React.JSX.Element {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const [value, setValue] = useState(defaultValue)

    // Reset / focus / select on each open.
    useEffect(() => {
        if (!visible) return
        setValue(defaultValue)
        // Defer to next tick so Blueprint's portal has mounted the input.
        const id = window.setTimeout(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        }, 0)
        return () => window.clearTimeout(id)
    }, [visible, defaultValue])

    const trimmed = value.trim()
    const invalid = trimmed.length > 0 && validate ? validate(trimmed) : null
    const canSubmit = trimmed.length > 0 && invalid === null

    const handleOk = (): void => {
        if (!canSubmit) return
        onResult(trimmed)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Enter' && canSubmit && !isImeKey(e.nativeEvent)) {
            e.preventDefault()
            handleOk()
        }
    }

    return (
        <DialogShell
            visible={visible}
            title={title}
            width="md"
            onCancel={() => onResult(null)}
            onOk={handleOk}
            okLabel={confirmLabel ?? 'OK'}
            okDisabled={!canSubmit}
        >
            <FormGroup
                label={label}
                labelFor="text-prompt-input"
                helperText={invalid ?? undefined}
                intent={invalid ? 'danger' : 'none'}
            >
                <InputGroup
                    id="text-prompt-input"
                    inputRef={(el) => {
                        inputRef.current = el
                    }}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    intent={invalid ? 'danger' : 'none'}
                    fill
                    autoComplete="off"
                />
            </FormGroup>
        </DialogShell>
    )
}
