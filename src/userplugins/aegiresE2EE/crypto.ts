import { gcm192 } from "./gcm192";

export interface Preset {
    readonly index: 0 | 1 | 2;
    readonly name: "AES128" | "AES192" | "AES256";
    readonly label: string;
    readonly keyBytes: number;
    readonly tagBytes: number;
    readonly padBlock: number;
}

export const PRESETS = {
    AES128: { index: 0, name: "AES128", label: "AES-128-GCM", keyBytes: 16, tagBytes: 12, padBlock: 16 },
    AES192: { index: 1, name: "AES192", label: "AES-192-GCM", keyBytes: 24, tagBytes: 14, padBlock: 32 },
    AES256: { index: 2, name: "AES256", label: "AES-256-GCM", keyBytes: 32, tagBytes: 16, padBlock: 64 }
} as const satisfies Record<string, Preset>;

export const PRESET_LIST: readonly Preset[] = [PRESETS.AES128, PRESETS.AES192, PRESETS.AES256];
export const DEFAULT_PRESET: Preset = PRESETS.AES256;

export function presetFromIndex(i: number): Preset | null {
    return PRESET_LIST.find(p => p.index === i) ?? null;
}

export const DISCORD_CONTENT_LIMIT = 2000;
export const PREFIX = "\u00A7";
const VERSION_MESSAGE = 2;
const VERSION_FILE = 3;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const MASTER_LEN = 32;
const FILE_CHUNK = 64 * 1024;
const FILE_PREFIX_LEN = 7;
const ARGON_PASSES = 3;
const ARGON_MEMORY_KIB = 64 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });
const USER_KEY_SALT = enc.encode("dcenc2|user-key|v1");

const B64_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64_ALPHA.charCodeAt(i)] = i;

export type MasterKey = CryptoKey;

export function looksEncrypted(s: string | null | undefined): s is string {
    return typeof s === "string" && s.startsWith(PREFIX);
}

export interface ArgonParams {
    readonly parallelism: number;
    readonly iterations: number;
    readonly memorySize: number;
    readonly hashLength: number;
}

export const ARGON_PARAMS: ArgonParams = {
    parallelism: 1,
    iterations: ARGON_PASSES,
    memorySize: ARGON_MEMORY_KIB,
    hashLength: MASTER_LEN
};

export type RawKdfProvider = (password: Uint8Array, salt: Uint8Array, params: ArgonParams) => Promise<Uint8Array | null>;
let rawKdfProvider: RawKdfProvider | null = null;

export function setRawKdfProvider(fn: RawKdfProvider | null): void {
    rawKdfProvider = fn;
}

export async function deriveKeyRaw(password: string | null | undefined, context?: string): Promise<Uint8Array | null> {
    if (!password || !rawKdfProvider) return null;
    const pw = enc.encode(password.normalize("NFKC"));
    const salt = context !== undefined ? enc.encode("dcenc2|ctx|" + context) : USER_KEY_SALT;
    try {
        return await rawKdfProvider(pw.slice(), salt.slice(), ARGON_PARAMS);
    } catch {
        return null;
    } finally {
        pw.fill(0);
    }
}

export async function importMasterKey(raw: Uint8Array): Promise<MasterKey> {
    return crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
}

export async function deriveKey(password: string | null | undefined, context?: string): Promise<MasterKey | null> {
    const raw = await deriveKeyRaw(password, context);
    if (!raw) return null;
    try {
        return await importMasterKey(raw);
    } finally {
        raw.fill(0);
    }
}

function maxRawBytesForChars(chars: number): number {
    let n = Math.floor((chars * 3) / 4) + 1;
    while (Math.floor((4 * n + 2) / 3) > chars) n--;
    return n;
}

export function maxPlaintextBytes(p: Preset): number {
    const raw = maxRawBytesForChars(DISCORD_CONTENT_LIMIT - PREFIX.length);
    const payloadCap = raw - 1 - SALT_LEN - p.tagBytes;
    return Math.floor(payloadCap / p.padBlock) * p.padBlock - 1;
}

export function utf8Length(s: string): number {
    return enc.encode(s).length;
}

export function fileOverhead(p: Preset, plainSize: number): number {
    const chunks = Math.max(1, Math.floor((plainSize + FILE_CHUNK - 1) / FILE_CHUNK));
    return 1 + SALT_LEN + chunks * p.tagBytes;
}

function toBase64NoPad(bytes: Uint8Array): string {
    const out: string[] = [];
    const len = bytes.length;
    let i = 0;
    for (; i + 2 < len; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out.push(B64_ALPHA[(n >> 18) & 63], B64_ALPHA[(n >> 12) & 63], B64_ALPHA[(n >> 6) & 63], B64_ALPHA[n & 63]);
    }
    const rem = len - i;
    if (rem === 1) {
        const n = bytes[i];
        out.push(B64_ALPHA[(n >> 2) & 63], B64_ALPHA[(n << 4) & 63]);
    } else if (rem === 2) {
        const n = (bytes[i] << 8) | bytes[i + 1];
        out.push(B64_ALPHA[(n >> 10) & 63], B64_ALPHA[(n >> 4) & 63], B64_ALPHA[(n << 2) & 63]);
    }
    return out.join("");
}

function fromBase64(str: string): Uint8Array | null {
    let end = str.length;
    while (end > 0 && str.charCodeAt(end - 1) === 61) end--;
    const rem = end & 3;
    if (rem === 1) return null;
    const out = new Uint8Array(((end >> 2) * 3) + (rem === 2 ? 1 : rem === 3 ? 2 : 0));
    let j = 0;
    let i = 0;
    for (; i + 3 < end; i += 4) {
        const a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2), d = str.charCodeAt(i + 3);
        if ((a | b | c | d) >= 128) return null;
        const va = B64_REV[a], vb = B64_REV[b], vc = B64_REV[c], vd = B64_REV[d];
        if ((va | vb | vc | vd) < 0) return null;
        const n = (va << 18) | (vb << 12) | (vc << 6) | vd;
        out[j++] = (n >> 16) & 0xff;
        out[j++] = (n >> 8) & 0xff;
        out[j++] = n & 0xff;
    }
    if (rem === 2) {
        const a = str.charCodeAt(i), b = str.charCodeAt(i + 1);
        if ((a | b) >= 128) return null;
        const va = B64_REV[a], vb = B64_REV[b];
        if ((va | vb) < 0) return null;
        out[j] = ((va << 2) | (vb >> 4)) & 0xff;
    } else if (rem === 3) {
        const a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
        if ((a | b | c) >= 128) return null;
        const va = B64_REV[a], vb = B64_REV[b], vc = B64_REV[c];
        if ((va | vb | vc) < 0) return null;
        out[j++] = ((va << 2) | (vb >> 4)) & 0xff;
        out[j] = (((vb & 0x0f) << 4) | (vc >> 2)) & 0xff;
    }
    return out;
}

function buildInfo(kind: "msg" | "file", preset: Preset, channelId: string, senderId: string): Uint8Array {
    const label = enc.encode("dcenc2/" + kind);
    const ch = enc.encode(channelId);
    const se = enc.encode(senderId);
    const out = new Uint8Array(label.length + 1 + 2 + ch.length + 2 + se.length);
    let pos = 0;
    out.set(label, pos); pos += label.length;
    out[pos++] = preset.index;
    out[pos++] = (ch.length >>> 8) & 0xff;
    out[pos++] = ch.length & 0xff;
    out.set(ch, pos); pos += ch.length;
    out[pos++] = (se.length >>> 8) & 0xff;
    out[pos++] = se.length & 0xff;
    out.set(se, pos);
    return out;
}

function buildAad(header: number, salt: Uint8Array, info: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + salt.length + info.length);
    out[0] = header;
    out.set(salt, 1);
    out.set(info, 1 + salt.length);
    return out;
}

async function hkdf(master: MasterKey, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
        master,
        length * 8
    );
    return new Uint8Array(bits);
}

async function gcmOp(
    encrypt: boolean,
    key: Uint8Array,
    nonce: Uint8Array,
    preset: Preset,
    aad: Uint8Array,
    data: Uint8Array
): Promise<Uint8Array> {
    if (preset.keyBytes === 24) {
        return gcm192(encrypt, key, nonce, preset.tagBytes, aad, data);
    }
    const usage: KeyUsage = encrypt ? "encrypt" : "decrypt";
    const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [usage]);
    const params: AesGcmParams = {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: preset.tagBytes * 8
    };
    const res = encrypt
        ? await crypto.subtle.encrypt(params, aesKey, data as BufferSource)
        : await crypto.subtle.decrypt(params, aesKey, data as BufferSource);
    return new Uint8Array(res);
}

function chunkNonce(prefix: Uint8Array, counter: number, last: boolean): Uint8Array {
    const n = new Uint8Array(NONCE_LEN);
    n.set(prefix, 0);
    n[7] = (counter >>> 24) & 0xff;
    n[8] = (counter >>> 16) & 0xff;
    n[9] = (counter >>> 8) & 0xff;
    n[10] = counter & 0xff;
    n[11] = last ? 1 : 0;
    return n;
}

export async function encrypt(
    plaintext: string,
    master: MasterKey,
    preset: Preset,
    channelId: string,
    senderId: string
): Promise<string | null> {
    if (plaintext == null || !master || !preset || !channelId || !senderId) return null;
    let data: Uint8Array | null = null;
    let payload: Uint8Array | null = null;
    let okm: Uint8Array | null = null;
    try {
        data = enc.encode(plaintext);
        if (data.length > maxPlaintextBytes(preset)) return null;

        const padded = Math.floor((data.length + 1 + preset.padBlock - 1) / preset.padBlock) * preset.padBlock;
        payload = new Uint8Array(padded);
        payload.set(data, 0);
        payload[data.length] = 0x80;

        const header = (VERSION_MESSAGE << 4) | preset.index;
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        const info = buildInfo("msg", preset, channelId, senderId);
        okm = await hkdf(master, salt, info, preset.keyBytes + NONCE_LEN);
        const aad = buildAad(header, salt, info);

        const ct = await gcmOp(
            true,
            okm.subarray(0, preset.keyBytes),
            okm.subarray(preset.keyBytes),
            preset,
            aad,
            payload
        );
        const wire = new Uint8Array(1 + SALT_LEN + ct.length);
        wire[0] = header;
        wire.set(salt, 1);
        wire.set(ct, 1 + SALT_LEN);
        return PREFIX + toBase64NoPad(wire);
    } catch {
        return null;
    } finally {
        data?.fill(0);
        payload?.fill(0);
        okm?.fill(0);
    }
}

export async function decrypt(
    wire: string,
    master: MasterKey,
    channelId: string,
    senderId: string
): Promise<string | null> {
    if (!looksEncrypted(wire) || !master || !channelId || !senderId) return null;
    let okm: Uint8Array | null = null;
    let payload: Uint8Array | null = null;
    try {
        const raw = fromBase64(wire.slice(PREFIX.length));
        if (!raw || raw.length < 1 + SALT_LEN + 1) return null;
        const header = raw[0];
        if ((header >> 4) !== VERSION_MESSAGE) return null;
        const preset = presetFromIndex(header & 0x0f);
        if (!preset) return null;

        const ctLen = raw.length - 1 - SALT_LEN;
        if (ctLen < preset.tagBytes + preset.padBlock || (ctLen - preset.tagBytes) % preset.padBlock !== 0)
            return null;

        const salt = raw.subarray(1, 1 + SALT_LEN);
        const info = buildInfo("msg", preset, channelId, senderId);
        okm = await hkdf(master, salt, info, preset.keyBytes + NONCE_LEN);
        const aad = buildAad(header, salt, info);

        payload = await gcmOp(
            false,
            okm.subarray(0, preset.keyBytes),
            okm.subarray(preset.keyBytes),
            preset,
            aad,
            raw.subarray(1 + SALT_LEN)
        );
        let end = payload.length;
        while (end > 0 && payload[end - 1] === 0) end--;
        if (end === 0 || payload[end - 1] !== 0x80) return null;
        return dec.decode(payload.subarray(0, end - 1));
    } catch {
        return null;
    } finally {
        okm?.fill(0);
        payload?.fill(0);
    }
}

export async function encryptBytes(
    plaintext: Uint8Array,
    master: MasterKey,
    preset: Preset,
    channelId: string,
    senderId: string
): Promise<Uint8Array | null> {
    if (!plaintext || !master || !preset || !channelId || !senderId) return null;
    let okm: Uint8Array | null = null;
    try {
        const header = (VERSION_FILE << 4) | preset.index;
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        const info = buildInfo("file", preset, channelId, senderId);
        okm = await hkdf(master, salt, info, preset.keyBytes + FILE_PREFIX_LEN);
        const key = okm.subarray(0, preset.keyBytes);
        const noncePrefix = okm.subarray(preset.keyBytes);
        const aad = buildAad(header, salt, info);

        const aesKey = preset.keyBytes === 24
            ? null
            : await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);

        const chunks = Math.max(1, Math.ceil(plaintext.length / FILE_CHUNK));
        if (chunks > 0xffffffff) return null;
        const out = new Uint8Array(1 + SALT_LEN + plaintext.length + chunks * preset.tagBytes);
        out[0] = header;
        out.set(salt, 1);
        let outPos = 1 + SALT_LEN;

        for (let counter = 0; counter < chunks; counter++) {
            const start = counter * FILE_CHUNK;
            const end = Math.min(start + FILE_CHUNK, plaintext.length);
            const last = counter === chunks - 1;
            const nonce = chunkNonce(noncePrefix, counter, last);
            const slice = plaintext.subarray(start, end);
            const ct = aesKey
                ? new Uint8Array(await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: preset.tagBytes * 8 },
                    aesKey,
                    slice as BufferSource
                ))
                : gcm192(true, key, nonce, preset.tagBytes, aad, slice);
            out.set(ct, outPos);
            outPos += ct.length;
        }
        return out;
    } catch {
        return null;
    } finally {
        okm?.fill(0);
    }
}

export async function decryptBytes(
    wire: Uint8Array,
    master: MasterKey,
    channelId: string,
    senderId: string
): Promise<Uint8Array | null> {
    if (!wire || !master || !channelId || !senderId) return null;
    let okm: Uint8Array | null = null;
    try {
        if (wire.length < 1 + SALT_LEN + 1) return null;
        const header = wire[0];
        if ((header >> 4) !== VERSION_FILE) return null;
        const preset = presetFromIndex(header & 0x0f);
        if (!preset) return null;

        const salt = wire.subarray(1, 1 + SALT_LEN);
        const body = wire.subarray(1 + SALT_LEN);
        if (body.length < preset.tagBytes) return null;

        const info = buildInfo("file", preset, channelId, senderId);
        okm = await hkdf(master, salt, info, preset.keyBytes + FILE_PREFIX_LEN);
        const key = okm.subarray(0, preset.keyBytes);
        const noncePrefix = okm.subarray(preset.keyBytes);
        const aad = buildAad(header, salt, info);

        const aesKey = preset.keyBytes === 24
            ? null
            : await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);

        const chunkCt = FILE_CHUNK + preset.tagBytes;
        const chunks = Math.ceil(body.length / chunkCt);
        if (chunks > 0xffffffff) return null;
        const plainParts: Uint8Array[] = [];
        let totalLen = 0;

        for (let counter = 0; counter < chunks; counter++) {
            const start = counter * chunkCt;
            const end = Math.min(start + chunkCt, body.length);
            if (end - start < preset.tagBytes) return null;
            const last = counter === chunks - 1;
            const nonce = chunkNonce(noncePrefix, counter, last);
            const slice = body.subarray(start, end);
            const pt = aesKey
                ? new Uint8Array(await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: preset.tagBytes * 8 },
                    aesKey,
                    slice as BufferSource
                ))
                : gcm192(false, key, nonce, preset.tagBytes, aad, slice);
            plainParts.push(pt);
            totalLen += pt.length;
        }
        const out = new Uint8Array(totalLen);
        let pos = 0;
        for (const p of plainParts) {
            out.set(p, pos);
            pos += p.length;
        }
        return out;
    } catch {
        return null;
    } finally {
        okm?.fill(0);
    }
}
