import "./styles.css";

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { TooltipContainer } from "@components/TooltipContainer";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import type { IconComponent } from "@utils/types";
import type { Message, RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, SelectedChannelStore, TextInput, useState } from "@webpack/common";
import type { KeyboardEvent } from "react";

import { looksEncrypted } from "./crypto";
import { useWireRecord } from "./engine";
import { isForced, keyFor } from "./forcedKeys";
import { clearUserKey, deriveAndSetUserKey, getSelectedPreset, setUserEnabled, toggleUserEnabled, useE2EEState } from "./state";

export const LockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className} fill="currentColor">
        <path d="M17 11V7a5 5 0 0 0-10 0v4H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2Zm-8 0V7a3 3 0 1 1 6 0v4H9Z" />
    </svg>
);

export const UnlockIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg viewBox="0 0 24 24" height={height} width={width} className={className} fill="currentColor">
        <path d="M17 11V7a5 5 0 0 0-9.9-1h2.06A3 3 0 0 1 15 7v4H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2Z" />
    </svg>
);

function E2EEModal({ rootProps }: { rootProps: RenderModalProps; }) {
    const { hasKey, enabled, deriving } = useE2EEState();
    const [password, setPassword] = useState("");
    const channelId = SelectedChannelStore.getChannelId();
    const forced = isForced(channelId);
    const preset = getSelectedPreset();

    const submit = async () => {
        const trimmed = password;
        if (!trimmed || deriving) return;
        setPassword("");
        const ok = await deriveAndSetUserKey(trimmed);
        if (ok) rootProps.onClose();
    };

    return (
        <Modal {...rootProps} title="Aegires E2EE">
            {forced && (
                <section className={Margins.bottom16}>
                    <Paragraph>
                        This channel is a <strong>forced E2EE channel</strong> ({keyFor(channelId) ? "key ready" : "deriving key..."}). Outgoing messages here are always encrypted with its built-in channel key.
                    </Paragraph>
                    <Divider className={Margins.top8} />
                </section>
            )}

            <section className={Margins.bottom16}>
                <Heading tag="h5" className={Margins.bottom8}>
                    Session Password ({preset.label})
                </Heading>
                <Paragraph className={Margins.bottom8}>
                    {deriving
                        ? "Deriving Argon2id master key..."
                        : hasKey
                            ? "A session key is active in memory. Enter a new password to switch keys, or clear it below."
                            : "Enter the shared password. Key is derived via Argon2id and kept in RAM for this session only."}
                </Paragraph>
                <TextInput
                    type="password"
                    placeholder="Shared passphrase"
                    value={password}
                    onChange={setPassword}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") void submit();
                    }}
                />
                <div className={classes("vc-aegires-modal-row", Margins.top8)}>
                    <Button variant="primary" size="small" disabled={!password || deriving} onClick={() => void submit()}>
                        {deriving ? "Deriving..." : hasKey ? "Switch Key" : "Set Key"}
                    </Button>
                    {hasKey && (
                        <Button
                            variant="dangerPrimary"
                            size="small"
                            disabled={deriving}
                            onClick={() => {
                                clearUserKey();
                                rootProps.onClose();
                            }}
                        >
                            Clear Key
                        </Button>
                    )}
                </div>
            </section>

            {hasKey && !forced && (
                <>
                    <Divider className={Margins.bottom16} />
                    <FormSwitch
                        title="Encrypt Outgoing Messages"
                        description="When disabled, you can still decrypt incoming messages while sending plaintext."
                        value={enabled}
                        onChange={setUserEnabled}
                        hideBorder
                    />
                </>
            )}
        </Modal>
    );
}

export function openE2EEModal(): void {
    openModal(props => <E2EEModal rootProps={props} />);
}

export const E2EEChatBarButton: ChatBarButtonFactory = ({ isAnyChat, channel }) => {
    const { hasKey, enabled, deriving } = useE2EEState();
    if (!isAnyChat) return null;

    const forced = isForced(channel?.id);
    const active = forced || (hasKey && enabled);

    const tooltip = deriving
        ? "Aegires E2EE: Deriving key..."
        : forced
            ? "Aegires E2EE: Forced channel (locked ON)"
            : hasKey
                ? (enabled
                    ? "Aegires E2EE: ON (click to toggle, Shift+click or right-click for key settings)"
                    : "Aegires E2EE: PAUSED (click to enable, Shift+click or right-click for key settings)")
                : "Aegires E2EE: Set session password";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={e => {
                if (forced || !hasKey || e.shiftKey) {
                    openE2EEModal();
                } else {
                    toggleUserEnabled();
                }
            }}
            onContextMenu={e => {
                e.preventDefault();
                openE2EEModal();
            }}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            {active
                ? <LockIcon className={classes("vc-aegires-btn", forced ? "vc-aegires-btn-forced" : "vc-aegires-btn-on")} />
                : <UnlockIcon className="vc-aegires-btn" />}
        </ChatBarButton>
    );
};

export function EncryptedBadge({ message }: { message: Message; }) {
    const rec = useWireRecord(message.id);
    const isEncrypted = rec !== undefined || looksEncrypted(message.content);
    if (!isEncrypted) return null;

    const decrypted = rec?.status === "decrypted";
    const presetLabel = rec?.preset?.label;
    const tip = decrypted
        ? `Encrypted with Aegires E2EE${presetLabel ? ` (${presetLabel})` : ""}`
        : rec?.status === "pending"
            ? "Decrypting Aegires E2EE message..."
            : "Encrypted message — set the matching session password to decrypt";

    return (
        <TooltipContainer text={tip}>
            <span className={classes("vc-aegires-badge", decrypted ? "vc-aegires-badge-ok" : "vc-aegires-badge-locked")}>
                <LockIcon width={14} height={14} />
            </span>
        </TooltipContainer>
    );
}
