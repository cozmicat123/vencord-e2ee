import { Button } from "@components/Button";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import type { Message, MessageAttachment } from "@vencord/discord-types";
import { React, useEffect, useState } from "@webpack/common";

import { useWireRecord } from "./engine";
import { isForced } from "./forcedKeys";
import {
    AUTO_DECRYPT_IMAGE_MAX,
    classifyAttachment,
    cleanDisplayFilename,
    getMediaState,
    isEncryptedAttachment,
    MAX_DECRYPT_BYTES,
    type MediaState,
    requestDecryptAttachment,
    subscribeMedia
} from "./media";
import { useE2EEState } from "./state";
import { openE2EEModal } from "./ui";

const h = React.createElement;

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function openDecryptedImageModal(blobUrl: string, filename: string) {
    openModal(props =>
        h(ModalRoot, { ...props, size: ModalSize.DYNAMIC },
            h(ModalHeader, null,
                h("span", { className: "vc-aegires-media-title" }, filename),
                h(ModalCloseButton, { onClick: props.onClose })
            ),
            h(ModalContent, { className: "vc-aegires-media-modal-body" },
                h("img", { src: blobUrl, alt: filename, className: "vc-aegires-media-modal-img" }),
                h("div", { className: "vc-aegires-media-actions" },
                    h("a", { href: blobUrl, download: filename, className: "vc-aegires-media-dl" }, `Save ${filename}`)
                )
            )
        )
    );
}

interface TileProps {
    attachment: MessageAttachment;
    channelId: string;
    senderId: string;
    dims?: { width: number; height: number; };
}

function EncryptedAttachmentTile({ attachment, channelId, senderId, dims }: TileProps) {
    const { hasKey } = useE2EEState();
    const forced = isForced(channelId);
    const keyAvailable = hasKey || forced;
    const { kind } = classifyAttachment(attachment.filename);
    const displayName = cleanDisplayFilename(attachment.filename);

    const [state, setState] = useState<MediaState | undefined>(() => getMediaState(attachment.url));

    useEffect(() => {
        setState(getMediaState(attachment.url));
        return subscribeMedia(attachment.url, () => setState(getMediaState(attachment.url)));
    }, [attachment.url]);

    useEffect(() => {
        if (!keyAvailable) return;
        if (state && state.status !== "locked") return;
        if (kind === "image" && attachment.size <= AUTO_DECRYPT_IMAGE_MAX) {
            requestDecryptAttachment(attachment, channelId, senderId);
        }
    }, [keyAvailable, attachment.url, attachment.size, kind, channelId, senderId, state?.status]);

    const aspectStyle = kind === "image" && dims && dims.width > 0 && dims.height > 0
        ? { aspectRatio: `${dims.width} / ${dims.height}` }
        : undefined;

    if (state?.status === "ready" && state.blobUrl) {
        const blobUrl = state.blobUrl;
        if (kind === "image") {
            return h("div", { className: "vc-aegires-media-wrap" },
                h("img", {
                    src: blobUrl,
                    alt: displayName,
                    className: "vc-aegires-media-img",
                    style: aspectStyle,
                    onClick: () => openDecryptedImageModal(blobUrl, displayName)
                })
            );
        }
        if (kind === "video") {
            return h("div", { className: "vc-aegires-media-wrap" },
                h("video", {
                    src: blobUrl,
                    controls: true,
                    playsInline: true,
                    preload: "metadata",
                    className: "vc-aegires-media-video"
                }),
                h("div", { className: "vc-aegires-media-bar" },
                    h("span", { className: "vc-aegires-media-name" }, displayName),
                    h("a", { href: blobUrl, download: displayName, className: "vc-aegires-media-dl" }, "Save")
                )
            );
        }
        if (kind === "audio") {
            return h("div", { className: "vc-aegires-media-card" },
                h("div", { className: "vc-aegires-media-bar" },
                    h("span", { className: "vc-aegires-media-name" }, displayName),
                    h("a", { href: blobUrl, download: displayName, className: "vc-aegires-media-dl" }, "Save")
                ),
                h("audio", { src: blobUrl, controls: true, className: "vc-aegires-media-audio" })
            );
        }
        return h("div", { className: "vc-aegires-media-card" },
            h("div", { className: "vc-aegires-media-bar" },
                h("span", { className: "vc-aegires-media-name" }, `${displayName} (${formatBytes(attachment.size)})`),
                h("a", { href: blobUrl, download: displayName, className: "vc-aegires-media-dl" }, "Download")
            )
        );
    }

    if (state?.status === "loading") {
        return h("div", { className: "vc-aegires-media-placeholder", style: aspectStyle },
            h("span", null, `Decrypting ${displayName}...`)
        );
    }

    if (!keyAvailable || state?.status === "locked") {
        return h("div", { className: "vc-aegires-media-card", style: aspectStyle },
            h("span", { className: "vc-aegires-media-name" }, `Encrypted ${kind}: ${displayName} (${formatBytes(attachment.size)})`),
            h(Button, { variant: "secondary", size: "small", onClick: () => openE2EEModal() }, "Set Key")
        );
    }

    if (state?.status === "too_large" || attachment.size > MAX_DECRYPT_BYTES) {
        return h("div", { className: "vc-aegires-media-card" },
            h("span", { className: "vc-aegires-media-name" }, `Encrypted ${kind}: ${displayName} (${formatBytes(attachment.size)}) — exceeds 64 MiB limit`)
        );
    }

    if (state?.status === "failed") {
        return h("div", { className: "vc-aegires-media-card" },
            h("span", { className: "vc-aegires-media-name" }, `${displayName}: ${state.error ?? "Decryption failed"}`),
            h(Button, {
                variant: "secondary",
                size: "small",
                onClick: () => requestDecryptAttachment(attachment, channelId, senderId)
            }, "Retry")
        );
    }

    return h("div", { className: "vc-aegires-media-card", style: aspectStyle },
        h("span", { className: "vc-aegires-media-name" }, `Encrypted ${kind}: ${displayName} (${formatBytes(attachment.size)})`),
        h(Button, {
            variant: "primary",
            size: "small",
            onClick: () => requestDecryptAttachment(attachment, channelId, senderId)
        }, "Decrypt")
    );
}

export function EncryptedAttachmentsAccessory({ message }: { message: Message; }) {
    const encAttachments = message?.attachments?.filter(isEncryptedAttachment) ?? [];
    const wireRec = useWireRecord(message?.id);
    if (encAttachments.length === 0 || !message?.author?.id) return null;

    let usedDims = false;
    return h("div", { className: "vc-aegires-media-list" },
        encAttachments.map(att => {
            const { kind } = classifyAttachment(att.filename);
            const dims = !usedDims && kind === "image" && wireRec?.dims
                ? (usedDims = true, wireRec.dims)
                : undefined;
            return h(EncryptedAttachmentTile, {
                key: att.id || att.url,
                attachment: att,
                channelId: message.channel_id,
                senderId: message.author.id,
                dims
            });
        })
    );
}
