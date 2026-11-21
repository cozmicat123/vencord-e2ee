import { decryptBytes, encryptBytes, type MasterKey, type Preset } from "./crypto";

const WORKER_SRC = `
const VERSION_FILE = 3, SALT_LEN = 16, FILE_CHUNK = 64 * 1024, FILE_PREFIX_LEN = 7;
const PRESETS = [{ index: 0, keyBytes: 16, tagBytes: 12 }, { index: 1, keyBytes: 24, tagBytes: 14 }, { index: 2, keyBytes: 32, tagBytes: 16 }];
const enc = new TextEncoder();
function buildInfo(pIdx, chId, seId) {
    const ch = enc.encode(chId), se = enc.encode(seId);
    const info = new Uint8Array(11 + 1 + 2 + ch.length + 2 + se.length);
    info.set(enc.encode("dcenc2/file"), 0);
    info[11] = pIdx & 0xff;
    info[12] = (ch.length >> 8) & 0xff; info[13] = ch.length & 0xff;
    info.set(ch, 14);
    const o = 14 + ch.length;
    info[o] = (se.length >> 8) & 0xff; info[o + 1] = se.length & 0xff;
    info.set(se, o + 2);
    return info;
}
function buildAad(h, salt, info) {
    const aad = new Uint8Array(1 + salt.length + info.length);
    aad[0] = h; aad.set(salt, 1); aad.set(info, 1 + salt.length);
    return aad;
}
function chunkNonce(prefix, c, last) {
    const n = new Uint8Array(12);
    n.set(prefix, 0);
    n[7] = (c >>> 24) & 0xff; n[8] = (c >>> 16) & 0xff; n[9] = (c >>> 8) & 0xff; n[10] = c & 0xff; n[11] = last ? 1 : 0;
    return n;
}
async function hkdf(master, salt, info, len) {
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, master, len * 8));
}
self.onmessage = async (ev) => {
    const { id, op, buffer, master, presetIndex, channelId, senderId } = ev.data;
    let okm = null;
    try {
        if (op === "encrypt") {
            const p = PRESETS[presetIndex];
            if (!p || p.keyBytes === 24) throw new Error("unsupported");
            const plain = new Uint8Array(buffer), header = (VERSION_FILE << 4) | p.index;
            const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
            const info = buildInfo(p.index, channelId, senderId);
            okm = await hkdf(master, salt, info, p.keyBytes + FILE_PREFIX_LEN);
            const aesKey = await crypto.subtle.importKey("raw", okm.subarray(0, p.keyBytes), "AES-GCM", false, ["encrypt"]);
            const prefix = okm.subarray(p.keyBytes), aad = buildAad(header, salt, info);
            const chunks = Math.max(1, Math.ceil(plain.length / FILE_CHUNK));
            const out = new Uint8Array(1 + SALT_LEN + plain.length + chunks * p.tagBytes);
            out[0] = header; out.set(salt, 1);
            let pos = 1 + SALT_LEN;
            for (let c = 0; c < chunks; c++) {
                const start = c * FILE_CHUNK, end = Math.min(start + FILE_CHUNK, plain.length);
                const ct = new Uint8Array(await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv: chunkNonce(prefix, c, c === chunks - 1), additionalData: aad, tagLength: p.tagBytes * 8 },
                    aesKey, plain.subarray(start, end)
                ));
                out.set(ct, pos); pos += ct.length;
            }
            self.postMessage({ id, ok: true, buffer: out.buffer }, [out.buffer]);
            return;
        }
        if (op === "decrypt") {
            const wire = new Uint8Array(buffer);
            if (wire.length < 1 + SALT_LEN + 1) throw new Error("short");
            const header = wire[0];
            if ((header >> 4) !== VERSION_FILE) throw new Error("bad-ver");
            const p = PRESETS[header & 0x0f];
            if (!p || p.keyBytes === 24) throw new Error("unsupported");
            const salt = wire.subarray(1, 1 + SALT_LEN), body = wire.subarray(1 + SALT_LEN);
            if (body.length < p.tagBytes) throw new Error("short");
            const info = buildInfo(p.index, channelId, senderId);
            okm = await hkdf(master, salt, info, p.keyBytes + FILE_PREFIX_LEN);
            const aesKey = await crypto.subtle.importKey("raw", okm.subarray(0, p.keyBytes), "AES-GCM", false, ["decrypt"]);
            const prefix = okm.subarray(p.keyBytes), aad = buildAad(header, salt, info);
            const chunkCt = FILE_CHUNK + p.tagBytes, chunks = Math.ceil(body.length / chunkCt);
            const parts = []; let total = 0;
            for (let c = 0; c < chunks; c++) {
                const start = c * chunkCt, end = Math.min(start + chunkCt, body.length);
                if (end - start < p.tagBytes) throw new Error("short-chunk");
                const pt = new Uint8Array(await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: chunkNonce(prefix, c, c === chunks - 1), additionalData: aad, tagLength: p.tagBytes * 8 },
                    aesKey, body.subarray(start, end)
                ));
                parts.push(pt); total += pt.length;
            }
            const out = new Uint8Array(total);
            let pos = 0;
            for (const pt of parts) { out.set(pt, pos); pos += pt.length; }
            self.postMessage({ id, ok: true, buffer: out.buffer }, [out.buffer]);
            return;
        }
        throw new Error("unknown");
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err) });
    } finally {
        if (okm) okm.fill(0);
    }
};
`;

let worker: Worker | null = null, workerUrl: string | null = null, workerDisabled = false, nextId = 1;
const pending = new Map<number, (buf: Uint8Array | null) => void>();

function getWorker(): Worker | null {
    if (workerDisabled || typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return null;
    if (worker) return worker;
    try {
        workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" }));
        worker = new Worker(workerUrl);
        worker.onmessage = ev => {
            const { id, ok, buffer } = ev.data ?? {};
            const res = pending.get(id);
            if (!res) return;
            pending.delete(id);
            res(ok && buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : null);
        };
        worker.onerror = () => { workerDisabled = true; terminateFileWorker(); };
        return worker;
    } catch {
        workerDisabled = true; terminateFileWorker(); return null;
    }
}

export function terminateFileWorker(): void {
    if (worker) { try { worker.terminate(); } catch {} worker = null; }
    if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch {} workerUrl = null; }
    for (const res of pending.values()) res(null);
    pending.clear();
}

function runWorkerJob(msg: Record<string, unknown>, transfer: ArrayBuffer): Promise<Uint8Array | null> {
    const w = getWorker();
    if (!w) return Promise.resolve(null);
    return new Promise(resolve => {
        const id = nextId++;
        pending.set(id, resolve);
        try { w.postMessage({ ...msg, id }, [transfer]); }
        catch { pending.delete(id); workerDisabled = true; terminateFileWorker(); resolve(null); }
    });
}

export async function encryptFileBytes(plaintext: Uint8Array, master: MasterKey, preset: Preset, channelId: string, senderId: string): Promise<Uint8Array | null> {
    if (preset.keyBytes !== 24 && !workerDisabled) {
        const copy = plaintext.slice();
        const res = await runWorkerJob({ op: "encrypt", buffer: copy.buffer, master, presetIndex: preset.index, channelId, senderId }, copy.buffer);
        if (res) return res;
    }
    return encryptBytes(plaintext, master, preset, channelId, senderId);
}

export async function decryptFileBytes(wire: Uint8Array, master: MasterKey, channelId: string, senderId: string): Promise<Uint8Array | null> {
    if (wire.length >= 1 && (wire[0] & 0x0f) !== 1 && !workerDisabled) {
        const copy = wire.slice();
        const res = await runWorkerJob({ op: "decrypt", buffer: copy.buffer, master, channelId, senderId }, copy.buffer);
        if (res) return res;
    }
    return decryptBytes(wire, master, channelId, senderId);
}
