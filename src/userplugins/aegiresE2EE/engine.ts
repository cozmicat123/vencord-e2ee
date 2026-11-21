import type { MessageObject } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import type { Message } from "@vencord/discord-types";
import { MessageStore, ReferencedMessageStore, SelectedChannelStore, showToast, useEffect, useState, UserStore } from "@webpack/common";

import { decrypt, encrypt, looksEncrypted, maxPlaintextBytes, PREFIX, type Preset, presetFromIndex, utf8Length } from "./crypto";
import { isForced, keyFor, prepare } from "./forcedKeys";
import { extractSizeTag, type ParsedSizeTag } from "./sizeTag";
import { getEffectiveKey, getSelectedPreset, getUserKey, shouldEncryptChannel } from "./state";

export type DecryptStatus = "pending" | "decrypted" | "failed";

export interface WireRecord {
    channelId: string;
    senderId: string;
    wireContent: string;
    plaintext?: string;
    status: DecryptStatus;
    preset: Preset | null;
    dims?: { width: number; height: number; };
}

const MAX_WIRE_RECORDS = 2000;

const wireRecords = new Map<string, WireRecord>();
const inflightDecrypts = new Map<string, number>();
const messageListeners = new Map<string, Set<() => void>>();

let decryptEpoch = 0;
let replyStoreRef: { set?: (channelId: string, messageId: string, entry: any) => void; } | null = null;

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
        const cb = () => {
            const current = wireRecords.get(messageId);
            setRec(current ? { ...current } : undefined);
        };
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

function updateReferencedMessageContent(channelId: string, messageId: string, content: string): void {
    if (!replyStoreRef?.set || !ReferencedMessageStore) return;
    try {
        const entry = ReferencedMessageStore.getMessageByReference({ channel_id: channelId, message_id: messageId });
        if (entry?.message && entry.message.content !== content) {
            const nextMsg = typeof (entry.message as any).merge === "function"
                ? (entry.message as any).merge({ content })
                : entry.message;
            replyStoreRef.set(channelId, messageId, { ...entry, message: nextMsg });
            ReferencedMessageStore.emitChange?.();
        }
    } catch {
        // Ignore if Discord changes ReferencedMessageStore internals
    }
}

async function decryptRecord(messageId: string, rec: WireRecord): Promise<void> {
    const epoch = decryptEpoch;
    inflightDecrypts.set(messageId, epoch);

    let key = getEffectiveKey(rec.channelId);
    if (!key && isForced(rec.channelId)) {
        key = await prepare(rec.channelId);
        if (epoch !== decryptEpoch) return;
    }

    if (!key) {
        rec.status = "failed";
        rec.plaintext = undefined;
        notifyMessage(messageId);
        return;
    }

    const plain = await decrypt(rec.wireContent, key, rec.channelId, rec.senderId);
    if (epoch !== decryptEpoch || inflightDecrypts.get(messageId) !== epoch) return;

    if (plain === null) {
        rec.status = "failed";
        rec.plaintext = undefined;
        updateMessage(rec.channelId, messageId, { content: rec.wireContent });
        updateReferencedMessageContent(rec.channelId, messageId, rec.wireContent);
        notifyMessage(messageId);
        return;
    }

    const parsed: ParsedSizeTag | null = extractSizeTag(plain);
    const displayText = parsed ? parsed.cleaned : plain;
    rec.plaintext = displayText;
    rec.dims = parsed ? { width: parsed.width, height: parsed.height } : undefined;
    rec.status = "decrypted";

    updateMessage(rec.channelId, messageId, { content: displayText });
    updateReferencedMessageContent(rec.channelId, messageId, displayText);
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
            queueMicrotask(() => {
                updateMessage(channelId, msg.id!, { content: existing.plaintext! });
                updateReferencedMessageContent(channelId, msg.id!, existing.plaintext!);
            });
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
    const list: Message[] | undefined = (collection as any)?._array;
    if (!Array.isArray(list)) return;

    for (const m of list) {
        const existing = wireRecords.get(m.id);
        if (existing) {
            if (existing.status !== "decrypted") {
                void decryptRecord(m.id, existing);
            } else if (existing.plaintext !== undefined && m.content === existing.wireContent) {
                updateMessage(channelId, m.id, { content: existing.plaintext });
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
    inflightDecrypts.clear();

    if (reason === "clear") {
        for (const [id, rec] of wireRecords) {
            if (isForced(rec.channelId)) continue;
            rec.status = "failed";
            rec.plaintext = undefined;
            updateMessage(rec.channelId, id, { content: rec.wireContent });
            updateReferencedMessageContent(rec.channelId, id, rec.wireContent);
            notifyMessage(id);
        }
        return;
    }

    for (const [id, rec] of wireRecords) {
        if (isForced(rec.channelId)) continue;
        rec.status = "pending";
        notifyMessage(id);
        void decryptRecord(id, rec);
    }

    scanChannel(SelectedChannelStore.getChannelId());
}

export function resetEngine(): void {
    decryptEpoch++;
    inflightDecrypts.clear();
    for (const [id, rec] of wireRecords) {
        updateMessage(rec.channelId, id, { content: rec.wireContent });
        updateReferencedMessageContent(rec.channelId, id, rec.wireContent);
    }
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

export function handleBeforeMessageSend(channelId: string, messageObj: MessageObject) {
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
