import type { MessageObject } from "@api/MessageEvents";
import type { Message } from "@vencord/discord-types";
import { DraftType, MessageCache, MessageStore, ReferencedMessageStore, SelectedChannelStore, showToast, UploadAttachmentStore, useEffect, useState, UserStore } from "@webpack/common";

import { decrypt, encrypt, looksEncrypted, maxPlaintextBytes, PREFIX, type Preset, presetFromIndex, utf8Length } from "./crypto";
import { isForced, keyFor, prepare } from "./forcedKeys";
import { clearMediaCache, probeImageDimensions } from "./media";
import { extractSizeTag, type ParsedSizeTag } from "./sizeTag";
import { getEffectiveKey, getSelectedPreset, getUserKey, shouldEncryptChannel } from "./state";

export type DecryptStatus = "pending" | "decrypted" | "failed";

export interface WireRecord {
    readonly channelId: string;
    readonly senderId: string;
    readonly wireContent: string;
    readonly plaintext?: string;
    readonly status: DecryptStatus;
    readonly preset: Preset | null;
    readonly dims?: { readonly width: number; readonly height: number; };
}

const MAX_WIRE_RECORDS = 2000;
const BATCH_FLUSH_MS = 12;

const wireRecords = new Map<string, WireRecord>();
const inflightDecrypts = new Map<string, number>();
const messageListeners = new Map<string, Set<() => void>>();

const pendingContentUpdates = new Map<string, Map<string, string>>();
const pendingRefUpdates = new Map<string, Map<string, string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let decryptEpoch = 0;
let replyStoreRef: { set?: (channelId: string, messageId: string, entry: any) => void; } | null = null;

function flushPendingUpdates(): void {
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    let anyMessageChanged = false;
    for (const [channelId, updates] of pendingContentUpdates) {
        let cache = MessageCache.getOrCreate(channelId);
        let channelDirty = false;
        for (const [messageId, content] of updates) {
            if (!cache.has(messageId)) continue;
            if (MessageStore.getMessage(channelId, messageId)?.content === content) continue;
            cache = cache.update(messageId, (oldMessage: any) => oldMessage.merge({ content }));
            channelDirty = true;
        }
        if (channelDirty) {
            MessageCache.commit(cache);
            anyMessageChanged = true;
        }
    }
    pendingContentUpdates.clear();
    if (anyMessageChanged) MessageStore.emitChange();

    let anyRefChanged = false;
    if (replyStoreRef?.set && ReferencedMessageStore) {
        for (const [channelId, updates] of pendingRefUpdates) {
            for (const [messageId, content] of updates) {
                try {
                    const entry = ReferencedMessageStore.getMessageByReference({ channel_id: channelId, message_id: messageId });
                    if (entry?.message && entry.message.content !== content) {
                        const nextMsg = typeof (entry.message as any).merge === "function"
                            ? (entry.message as any).merge({ content })
                            : entry.message;
                        replyStoreRef.set(channelId, messageId, { ...entry, message: nextMsg });
                        anyRefChanged = true;
                    }
                } catch {
                    // Ignore if Discord changes ReferencedMessageStore internals
                }
            }
        }
    }
    pendingRefUpdates.clear();
    if (anyRefChanged) ReferencedMessageStore.emitChange?.();
}

function queueContentUpdate(channelId: string, messageId: string, content: string): void {
    let ch = pendingContentUpdates.get(channelId);
    if (!ch) {
        ch = new Map();
        pendingContentUpdates.set(channelId, ch);
    }
    ch.set(messageId, content);

    let ref = pendingRefUpdates.get(channelId);
    if (!ref) {
        ref = new Map();
        pendingRefUpdates.set(channelId, ref);
    }
    ref.set(messageId, content);

    if (flushTimer === null) {
        flushTimer = setTimeout(flushPendingUpdates, BATCH_FLUSH_MS);
    }
}

function setWireRecord(messageId: string, rec: WireRecord): void {
    if (wireRecords.has(messageId)) {
        wireRecords.delete(messageId);
    }
    wireRecords.set(messageId, rec);

    if (wireRecords.size > MAX_WIRE_RECORDS) {
        for (const id of wireRecords.keys()) {
            if (wireRecords.size <= MAX_WIRE_RECORDS) break;
            if (messageListeners.has(id)) continue;
            wireRecords.delete(id);
            inflightDecrypts.delete(id);
        }
    }
}

function deleteWireRecord(messageId: string): void {
    inflightDecrypts.delete(messageId);
    if (wireRecords.delete(messageId)) {
        notifyMessage(messageId);
    }
}

function decodeHeaderPreset(wire: string): Preset | null {
    try {
        const b64 = wire.slice(PREFIX.length);
        if (b64.length < 2) return null;
        const bin = atob(b64.slice(0, 4));
        if (!bin.length) return null;
        return presetFromIndex(bin.charCodeAt(0) & 0x0f);
    } catch {
        return null;
    }
}

function notifyMessage(messageId: string) {
    const set = messageListeners.get(messageId);
    if (!set) return;
    for (const fn of set) fn();
}

export function getWireRecord(messageId: string): WireRecord | undefined {
    return wireRecords.get(messageId);
}

export function useWireRecord(messageId: string): WireRecord | undefined {
    const [rec, setRec] = useState<WireRecord | undefined>(() => wireRecords.get(messageId));
    useEffect(() => {
        setRec(wireRecords.get(messageId));
        let set = messageListeners.get(messageId);
        if (!set) {
            set = new Set();
            messageListeners.set(messageId, set);
        }
        const cb = () => setRec(wireRecords.get(messageId));
        set.add(cb);
        return () => {
            set?.delete(cb);
            if (set?.size === 0) messageListeners.delete(messageId);
        };
    }, [messageId]);
    return rec;
}

export function setReplyStore(store: any): void {
    replyStoreRef = store;
}

async function decryptRecord(messageId: string, rec: WireRecord): Promise<void> {
    const epoch = decryptEpoch;
    inflightDecrypts.set(messageId, epoch);

    let key = getEffectiveKey(rec.channelId);
    if (!key && isForced(rec.channelId)) {
        key = await prepare(rec.channelId);
        if (epoch !== decryptEpoch || inflightDecrypts.get(messageId) !== epoch) return;
    }

    if (!key) {
        setWireRecord(messageId, { ...rec, status: "failed", plaintext: undefined, dims: undefined });
        notifyMessage(messageId);
        return;
    }

    const plain = await decrypt(rec.wireContent, key, rec.channelId, rec.senderId);
    if (epoch !== decryptEpoch || inflightDecrypts.get(messageId) !== epoch) return;

    if (plain === null) {
        setWireRecord(messageId, { ...rec, status: "failed", plaintext: undefined, dims: undefined });
        queueContentUpdate(rec.channelId, messageId, rec.wireContent);
        notifyMessage(messageId);
        return;
    }

    const parsed: ParsedSizeTag | null = extractSizeTag(plain);
    const displayText = parsed ? parsed.cleaned : plain;
    setWireRecord(messageId, {
        ...rec,
        plaintext: displayText,
        dims: parsed ? { width: parsed.width, height: parsed.height } : undefined,
        status: "decrypted"
    });

    queueContentUpdate(rec.channelId, messageId, displayText);
    notifyMessage(messageId);
}

export function ingestRawMessage(msg: Partial<Message> & { referenced_message?: Partial<Message> | null; }, fallbackChannelId?: string): void {
    if (!msg?.id) return;
    const existing = wireRecords.get(msg.id);
    const channelId = msg.channel_id ?? fallbackChannelId ?? existing?.channelId;

    if (msg.referenced_message?.id) {
        ingestRawMessage(msg.referenced_message, msg.referenced_message.channel_id ?? channelId);
    }

    if (!channelId || typeof msg.content !== "string") return;

    const senderId = msg.author?.id ?? existing?.senderId ?? MessageStore.getMessage(channelId, msg.id)?.author?.id;
    if (!senderId) return;

    if (looksEncrypted(msg.content)) {
        if (existing && existing.wireContent === msg.content && existing.status === "decrypted" && existing.plaintext !== undefined) {
            queueContentUpdate(channelId, msg.id, existing.plaintext);
            return;
        }
        const rec: WireRecord = {
            channelId,
            senderId,
            wireContent: msg.content,
            status: "pending",
            preset: decodeHeaderPreset(msg.content)
        };
        setWireRecord(msg.id, rec);
        notifyMessage(msg.id);
        void decryptRecord(msg.id, rec);
    } else if (existing && existing.plaintext !== msg.content) {
        deleteWireRecord(msg.id);
    }
}

export function scanChannel(channelId: string | null | undefined): void {
    if (!channelId) return;
    if (isForced(channelId) && !keyFor(channelId)) {
        void prepare(channelId).then(k => {
            if (k) scanChannel(channelId);
        });
    }
    const collection = MessageStore.getMessages(channelId);
    const list: Message[] | undefined = (collection as any)?.toArray?.() ?? (collection as any)?._array;
    if (!Array.isArray(list)) return;

    for (const m of list) {
        const existing = wireRecords.get(m.id);
        if (existing) {
            if (existing.status !== "decrypted") {
                void decryptRecord(m.id, existing);
            } else if (existing.plaintext !== undefined && m.content === existing.wireContent) {
                queueContentUpdate(channelId, m.id, existing.plaintext);
            }
        } else if (looksEncrypted(m.content)) {
            ingestRawMessage(m, channelId);
        }

        if (m.messageReference?.message_id && ReferencedMessageStore) {
            const refEntry = ReferencedMessageStore.getMessageByReference(m.messageReference);
            if (refEntry?.message) {
                ingestRawMessage(refEntry.message, m.messageReference.channel_id ?? channelId);
            }
        }
    }
}

export function handleKeyChanged(reason: "set" | "clear"): void {
    decryptEpoch++;
    clearMediaCache(false);
    inflightDecrypts.clear();

    const snapshot = Array.from(wireRecords.entries());
    if (reason === "clear") {
        for (const [id, rec] of snapshot) {
            if (isForced(rec.channelId)) continue;
            setWireRecord(id, { ...rec, status: "failed", plaintext: undefined, dims: undefined });
            queueContentUpdate(rec.channelId, id, rec.wireContent);
            notifyMessage(id);
        }
        flushPendingUpdates();
        return;
    }

    for (const [id, rec] of snapshot) {
        if (isForced(rec.channelId)) continue;
        const pendingRec: WireRecord = { ...rec, status: "pending" };
        setWireRecord(id, pendingRec);
        notifyMessage(id);
        void decryptRecord(id, pendingRec);
    }

    scanChannel(SelectedChannelStore.getChannelId());
}

export function resetEngine(): void {
    decryptEpoch++;
    clearMediaCache(true);
    inflightDecrypts.clear();
    pendingContentUpdates.clear();
    pendingRefUpdates.clear();
    for (const [id, rec] of wireRecords) {
        queueContentUpdate(rec.channelId, id, rec.wireContent);
    }
    flushPendingUpdates();
    wireRecords.clear();
    messageListeners.clear();
    replyStoreRef = null;
}

async function encryptOutgoing(channelId: string, messageObj: MessageObject): Promise<void | { cancel: boolean; }> {
    if (!shouldEncryptChannel(channelId)) return;
    if (!messageObj.content || looksEncrypted(messageObj.content)) return;

    const senderId = UserStore.getCurrentUser()?.id;
    if (!senderId) {
        showToast({ text: "Could not resolve current user ID — send cancelled", variant: "critical" });
        return { cancel: true };
    }

    let key = isForced(channelId) ? keyFor(channelId) : getUserKey();
    if (!key && isForced(channelId)) {
        showToast({ text: "Deriving forced channel key..." });
        key = await prepare(channelId);
    }
    if (!key) {
        showToast({ text: "E2EE key unavailable — message cancelled", variant: "critical" });
        return { cancel: true };
    }

    const preset = getSelectedPreset();
    const bytes = utf8Length(messageObj.content);
    const limit = maxPlaintextBytes(preset);
    if (bytes > limit) {
        showToast({ text: `Message too long for ${preset.label} (${bytes}/${limit} bytes)`, variant: "critical" });
        return { cancel: true };
    }

    const wire = await encrypt(messageObj.content, key, preset, channelId, senderId);
    if (!wire) {
        showToast({ text: "Encryption failed — message cancelled", variant: "critical" });
        return { cancel: true };
    }

    messageObj.content = wire;
}

export async function handleBeforeMessageSend(channelId: string, messageObj: MessageObject) {
    if (shouldEncryptChannel(channelId) && !looksEncrypted(messageObj.content)) {
        const uploads = UploadAttachmentStore?.getUploads?.(channelId, DraftType.ChannelMessage) ?? [];
        const firstImg = uploads.find(u => u?.isImage && u.item?.file);
        if (firstImg) {
            const dims = await probeImageDimensions(firstImg.item.file);
            if (dims) {
                messageObj.content = `[sz:${dims.width},${dims.height}]${messageObj.content ?? ""}`;
            }
        }
    }
    return encryptOutgoing(channelId, messageObj);
}

export function handleBeforeMessageEdit(channelId: string, _messageId: string, messageObj: MessageObject) {
    return encryptOutgoing(channelId, messageObj);
}

export const fluxHandlers = {
    LOAD_MESSAGES_SUCCESS(ev: { channelId?: string; messages?: Message[]; }) {
        if (!Array.isArray(ev.messages)) return;
        for (const m of ev.messages) {
            ingestRawMessage(m, ev.channelId);
        }
        if (ev.channelId && isForced(ev.channelId) && !keyFor(ev.channelId)) {
            void prepare(ev.channelId).then(k => {
                if (k) scanChannel(ev.channelId);
            });
        }
    },
    MESSAGE_CREATE(ev: { channelId?: string; message?: Message; }) {
        if (ev.message) ingestRawMessage(ev.message, ev.channelId);
    },
    MESSAGE_UPDATE(ev: { message?: Partial<Message>; }) {
        if (!ev.message?.id) return;
        if (typeof ev.message.content === "string") {
            ingestRawMessage(ev.message, ev.message.channel_id);
        }
    },
    MESSAGE_DELETE(ev: { id?: string; }) {
        if (ev.id) deleteWireRecord(ev.id);
    },
    MESSAGE_DELETE_BULK(ev: { ids?: string[]; }) {
        if (!Array.isArray(ev.ids)) return;
        for (const id of ev.ids) deleteWireRecord(id);
    },
    CHANNEL_SELECT(ev: { channelId?: string | null; }) {
        if (ev.channelId) {
            queueMicrotask(() => scanChannel(ev.channelId));
        }
    }
};
