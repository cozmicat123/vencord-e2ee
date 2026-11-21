import type { CloudUpload, MessageAttachment } from "@vencord/discord-types";
import { showToast, UserStore } from "@webpack/common";

import { decryptFileBytes, encryptFileBytes, terminateFileWorker } from "./fileWorker";
import { addEncSuffix, isEncryptedFilename, randomFor } from "./fileNames";
import { isForced, keyFor, prepare } from "./forcedKeys";
import { getEffectiveKey, getSelectedPreset, getUserKey, shouldEncryptChannel } from "./state";

export const AUTO_DECRYPT_IMAGE_MAX = 6 * 1024 * 1024;
export const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100;
const ENCRYPTED_UPLOAD_MARK = Symbol("aegiresEncryptedUpload");

export type MediaKind = "image" | "video" | "audio" | "file";
export type MediaStatus = "locked" | "loading" | "ready" | "failed" | "too_large";

export interface MediaState {
    status: MediaStatus;
    blobUrl?: string;
    mime: string;
    kind: MediaKind;
    error?: string;
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", "3gp": "video/3gpp", mkv: "video/x-matroska",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
    pdf: "application/pdf", txt: "text/plain", json: "application/json", zip: "application/zip"
};

const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "3gp", "mkv"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "flac", "m4a", "aac", "opus"]);

export function isEncryptedAttachment(a: Pick<MessageAttachment, "filename"> | null | undefined): boolean {
    return isEncryptedFilename(a?.filename);
}

export function cleanDisplayFilename(filename: string): string {
    if (filename.includes(".enc.")) return filename.replace(".enc.", ".");
    if (filename.endsWith(".enc")) return filename.slice(0, -4) || "file";
    return filename;
}

function extOf(filename: string): string {
    const clean = cleanDisplayFilename(filename);
    const dot = clean.lastIndexOf(".");
    return dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function classifyAttachment(filename: string): { kind: MediaKind; mime: string; } {
    const ext = extOf(filename);
    const mime = EXT_TO_MIME[ext] ?? "application/octet-stream";
    if (IMAGE_EXTS.has(ext)) return { kind: "image", mime };
    if (VIDEO_EXTS.has(ext)) return { kind: "video", mime };
    if (AUDIO_EXTS.has(ext)) return { kind: "audio", mime };
    return { kind: "file", mime };
}

export function baseUrl(url: string): string {
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
}

const cache = new Map<string, MediaState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();
let mediaEpoch = 0;

function notifyKey(key: string): void {
    const set = listeners.get(key);
    if (set) for (const fn of set) fn();
}

function setEntry(key: string, entry: MediaState): void {
    const prev = cache.get(key);
    if (prev?.blobUrl && prev.blobUrl !== entry.blobUrl) {
        try { URL.revokeObjectURL(prev.blobUrl); } catch {}
    }
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
            const oldest = cache.get(oldestKey);
            if (oldest?.blobUrl) {
                try { URL.revokeObjectURL(oldest.blobUrl); } catch {}
            }
            cache.delete(oldestKey);
        }
    }
    notifyKey(key);
}

export function getMediaState(url: string): MediaState | undefined {
    return cache.get(baseUrl(url));
}

export function subscribeMedia(url: string, fn: () => void): () => void {
    const key = baseUrl(url);
    let set = listeners.get(key);
    if (!set) {
        set = new Set();
        listeners.set(key, set);
    }
    set.add(fn);
    globalListeners.add(fn);
    return () => {
        set!.delete(fn);
        if (set!.size === 0) listeners.delete(key);
        globalListeners.delete(fn);
    };
}

export function clearMediaCache(terminateWorker = false): void {
    mediaEpoch++;
    for (const entry of cache.values()) {
        if (entry.blobUrl) {
            try { URL.revokeObjectURL(entry.blobUrl); } catch {}
        }
    }
    cache.clear();
    inflight.clear();
    if (terminateWorker) terminateFileWorker();
    for (const fn of globalListeners) fn();
}

export function requestDecryptAttachment(
    attachment: MessageAttachment,
    channelId: string,
    senderId: string
): void {
    const key = baseUrl(attachment.url);
    if (inflight.has(key)) return;
    const { kind, mime } = classifyAttachment(attachment.filename);

    if (attachment.size > MAX_DECRYPT_BYTES) {
        setEntry(key, { status: "too_large", kind, mime, error: "File exceeds 64 MiB limit" });
        return;
    }

    const epoch = mediaEpoch;
    setEntry(key, { status: "loading", kind, mime });

    const job = (async () => {
        try {
            let master = getEffectiveKey(channelId);
            if (!master && isForced(channelId)) {
                master = await prepare(channelId);
                if (epoch !== mediaEpoch) return;
            }
            if (!master) {
                setEntry(key, { status: "locked", kind, mime });
                return;
            }

            const resp = await fetch(attachment.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const wire = new Uint8Array(await resp.arrayBuffer());
            if (epoch !== mediaEpoch) return;

            const plain = await decryptFileBytes(wire, master, channelId, senderId);
            if (epoch !== mediaEpoch) return;
            if (!plain) {
                setEntry(key, { status: "failed", kind, mime, error: "Decryption failed (wrong key or tampered)" });
                return;
            }

            const blob = new Blob([plain as BlobPart], { type: mime });
            const blobUrl = URL.createObjectURL(blob);
            if (epoch !== mediaEpoch) {
                try { URL.revokeObjectURL(blobUrl); } catch {}
                return;
            }
            setEntry(key, { status: "ready", blobUrl, kind, mime });
        } catch (err) {
            if (epoch !== mediaEpoch) return;
            setEntry(key, { status: "failed", kind, mime, error: String(err instanceof Error ? err.message : err) });
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, job);
}

export async function probeImageDimensions(file: File): Promise<{ width: number; height: number; } | null> {
    if (typeof createImageBitmap === "function") {
        try {
            const bmp = await createImageBitmap(file);
            const dims = { width: bmp.width, height: bmp.height };
            bmp.close();
            return dims.width > 0 && dims.height > 0 ? dims : null;
        } catch {}
    }
    if (typeof Image === "undefined" || typeof URL === "undefined") return null;
    const url = URL.createObjectURL(file);
    try {
        return await new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
            img.onerror = () => resolve(null);
            img.src = url;
        });
    } finally {
        try { URL.revokeObjectURL(url); } catch {}
    }
}

export async function encryptUploads(uploads: CloudUpload[]): Promise<void> {
    if (!Array.isArray(uploads) || uploads.length === 0) return;
    const channelId = uploads[0]?.channelId;
    if (!channelId || !shouldEncryptChannel(channelId)) return;

    const senderId = UserStore.getCurrentUser()?.id;
    if (!senderId) {
        showToast({ text: "Could not resolve user ID — upload cancelled", variant: "critical" });
        throw new Error("AegiresE2EE: missing senderId");
    }

    let key = isForced(channelId) ? keyFor(channelId) : getUserKey();
    if (!key && isForced(channelId)) {
        showToast({ text: "Deriving forced channel key..." });
        key = await prepare(channelId);
    }
    if (!key) {
        showToast({ text: "E2EE key unavailable — upload cancelled", variant: "critical" });
        throw new Error("AegiresE2EE: missing key");
    }

    const preset = getSelectedPreset();

    for (const upload of uploads) {
        if (!upload || (upload as any)[ENCRYPTED_UPLOAD_MARK] || isEncryptedFilename(upload.filename)) continue;
        const file = upload.item?.file;
        if (!file) {
            showToast({ text: "Cannot encrypt non-file upload — cancelled", variant: "critical" });
            throw new Error("AegiresE2EE: missing upload file");
        }

        const plain = new Uint8Array(await file.arrayBuffer());
        const encrypted = await encryptFileBytes(plain, key, preset, channelId, senderId);
        if (!encrypted) {
            showToast({ text: "File encryption failed — upload cancelled", variant: "critical" });
            throw new Error("AegiresE2EE: file encryption failed");
        }

        const origName = upload.filename || file.name || "file";
        const origMime = upload.mimeType || file.type || "application/octet-stream";
        const encName = addEncSuffix(randomFor(origName, origMime));
        const encFile = new File([encrypted as BlobPart], encName, { type: "application/octet-stream" });

        upload.item.file = encFile;
        upload.filename = encName;
        upload.mimeType = "application/octet-stream";
        upload.currentSize = encFile.size;
        upload.preCompressionSize = encFile.size;
        upload.isImage = false;
        upload.isVideo = false;
        (upload as any)[ENCRYPTED_UPLOAD_MARK] = true;
    }
}
