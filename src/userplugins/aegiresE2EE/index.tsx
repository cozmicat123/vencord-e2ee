import definePlugin from "@utils/types";
import { SelectedChannelStore } from "@webpack/common";

import { setRawKdfProvider } from "./crypto";
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
import { settings } from "./settings";
import { clearUserKey, setOnKeyChanged } from "./state";
import { E2EEChatBarButton, EncryptedBadge, LockIcon } from "./ui";

export default definePlugin({
    name: "AegiresE2EE",
    description: "End-to-end encryption compatible with Aegires Android client (Argon2id + HKDF + AES-GCM).",
    authors: [{ name: "aegires-port", id: 0n }],
    settings,

    patches: [
        {
            find: "ReferencedMessageStore",
            replacement: {
                match: /_channelCaches=new Map;/,
                replace: "$&_aegiresReplyStore=$self.setReplyStore(this);"
            }
        }
    ],

    setReplyStore,

    flux: fluxHandlers,

    chatBarButton: {
        icon: LockIcon,
        render: E2EEChatBarButton
    },

    renderMessageDecoration({ message }) {
        return <EncryptedBadge message={message} />;
    },

    onBeforeMessageSend: handleBeforeMessageSend,
    onBeforeMessageEdit: handleBeforeMessageEdit,

    start() {
        setRawKdfProvider(deriveKeyRawInWorker);
        setOnKeyChanged(handleKeyChanged);
        queueMicrotask(() => scanChannel(SelectedChannelStore.getChannelId()));
    },

    stop() {
        setOnKeyChanged(null);
        setRawKdfProvider(null);
        clearUserKey(true);
        clearForcedKeys();
        resetEngine();
    }
});
