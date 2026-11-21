import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { React, SelectedChannelStore } from "@webpack/common";

import { DEFAULT_PRESET, presetFromIndex, setRawKdfProvider } from "./crypto";
import {
    fluxHandlers,
    handleBeforeMessageEdit,
    handleBeforeMessageSend,
    handleKeyChanged,
    resetEngine,
    scanChannel,
    setReplyStore
} from "./engine";
import { clearForcedKeys } from "./forcedKeys";
import { deriveKeyRawInWorker } from "./kdfWorker";
import { encryptUploads, isEncryptedAttachment } from "./media";
import { EncryptedAttachmentsAccessory } from "./mediaUi";
import { settings } from "./settings";
import { clearUserKey, setOnKeyChanged, setPresetProvider } from "./state";
import managedStyle from "./styles.css?managed";
import { E2EEChatBarButton, EncryptedBadge, LockIcon } from "./ui";

export default definePlugin({
    name: "AegiresE2EE",
    description: "End-to-end encryption compatible with Aegires Android client (Argon2id + HKDF + AES-GCM).",
    authors: [{ name: "aegires-port", id: 0n }],
    settings,
    managedStyle,

    patches: [
        {
            find: "ReferencedMessageStore",
            replacement: {
                match: /_channelCaches=new Map;/,
                replace: "$&_aegiresReplyStore=$self.setReplyStore(this);"
            }
        },
        {
            find: "async uploadFiles(",
            replacement: {
                match: /async uploadFiles\((\i)\){/,
                replace: "$&await $self.encryptUploads($1);"
            }
        },
        {
            find: "}renderStickersAccessories(",
            replacement: {
                match: /renderAttachments\(\i\){.+?{attachments:(\i).+?;/,
                replace: (m, attachments) => `${m}${attachments}=$self.filterAttachments(${attachments});`
            }
        }
    ],

    setReplyStore,
    encryptUploads,

    filterAttachments(attachments: Message["attachments"]) {
        if (!Array.isArray(attachments)) return attachments;
        return attachments.filter(a => !isEncryptedAttachment(a));
    },

    flux: fluxHandlers,

    chatBarButton: {
        icon: LockIcon,
        render: E2EEChatBarButton
    },

    renderMessageDecoration({ message }) {
        return React.createElement(EncryptedBadge, { message });
    },

    renderMessageAccessory({ message }) {
        return React.createElement(EncryptedAttachmentsAccessory, { message });
    },

    onBeforeMessageSend: handleBeforeMessageSend,
    onBeforeMessageEdit: handleBeforeMessageEdit,

    start() {
        setPresetProvider(() => presetFromIndex(Number(settings.store.preset)) ?? DEFAULT_PRESET);
        setRawKdfProvider(deriveKeyRawInWorker);
        setOnKeyChanged(handleKeyChanged);
        queueMicrotask(() => scanChannel(SelectedChannelStore.getChannelId()));
    },

    stop() {
        setOnKeyChanged(null);
        setRawKdfProvider(null);
        setPresetProvider(null);
        clearUserKey(true);
        clearForcedKeys();
        resetEngine();
    }
});
