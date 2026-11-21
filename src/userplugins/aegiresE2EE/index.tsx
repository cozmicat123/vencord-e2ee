import definePlugin from "@utils/types";
import type { CloudUpload, Message } from "@vencord/discord-types";
import { waitFor } from "@webpack";
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
import { encryptSingleUpload, encryptUploads, isEncryptedAttachment } from "./media";
import { EncryptedAttachmentsAccessory } from "./mediaUi";
import { settings } from "./settings";
import { clearUserKey, setOnKeyChanged, setPresetProvider } from "./state";
import managedStyle from "./styles.css?managed";
import { E2EEChatBarButton, EncryptedBadge, LockIcon } from "./ui";

let hookedCloudUploadProto: { upload: (...args: any[]) => Promise<void> } | null = null;
let origCloudUpload: ((...args: any[]) => Promise<void>) | null = null;
let pluginActive = false;

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
        pluginActive = true;
        waitFor(m => m?.prototype?.trackUploadFinished && typeof m.prototype.upload === "function", (CloudUploadCtor: any) => {
            if (!pluginActive || hookedCloudUploadProto) return;
            const proto = CloudUploadCtor.prototype;
            origCloudUpload = proto.upload;
            hookedCloudUploadProto = proto;
            proto.upload = async function (this: CloudUpload, ...args: any[]) {
                await encryptSingleUpload(this);
                return origCloudUpload!.apply(this, args);
            };
        });
        setPresetProvider(() => presetFromIndex(Number(settings.store.preset)) ?? DEFAULT_PRESET);
        setRawKdfProvider(deriveKeyRawInWorker);
        setOnKeyChanged(handleKeyChanged);
        queueMicrotask(() => scanChannel(SelectedChannelStore.getChannelId()));
    },

    stop() {
        pluginActive = false;
        if (hookedCloudUploadProto && origCloudUpload) {
            hookedCloudUploadProto.upload = origCloudUpload;
            hookedCloudUploadProto = null;
            origCloudUpload = null;
        }
        setOnKeyChanged(null);
        setRawKdfProvider(null);
        setPresetProvider(null);
        clearUserKey(true);
        clearForcedKeys();
        resetEngine();
    }
});
