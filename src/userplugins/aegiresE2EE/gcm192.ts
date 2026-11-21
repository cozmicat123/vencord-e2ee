import { ctr, ecb } from "@noble/ciphers/aes.js";
import { ghash } from "@noble/ciphers/_polyval.js";
import { equalBytes } from "@noble/ciphers/utils.js";

function computeTag(
    hKey: Uint8Array,
    tagMask: Uint8Array,
    aad: Uint8Array,
    ct: Uint8Array,
    tagBytes: number
): Uint8Array {
    const h = ghash.create(hKey);
    if (aad.length > 0) h.update(aad);
    if (ct.length > 0) h.update(ct);
    const lenBlock = new Uint8Array(16);
    const dv = new DataView(lenBlock.buffer);
    dv.setBigUint64(0, BigInt(aad.length) * 8n, false);
    dv.setBigUint64(8, BigInt(ct.length) * 8n, false);
    h.update(lenBlock);
    const fullTag = h.digest();
    const out = new Uint8Array(tagBytes);
    for (let i = 0; i < tagBytes; i++) out[i] = fullTag[i] ^ tagMask[i];
    fullTag.fill(0);
    return out;
}

export function gcm192(
    encrypt: boolean,
    key: Uint8Array,
    nonce: Uint8Array,
    tagBytes: number,
    aad: Uint8Array,
    data: Uint8Array
): Uint8Array {
    if (key.length !== 24 || nonce.length !== 12 || tagBytes < 12 || tagBytes > 16)
        throw new Error("aes192-gcm: invalid parameters");
    const blocks = new Uint8Array(32);
    blocks.set(nonce, 16);
    blocks[31] = 1;
    const encBlocks = ecb(key, { disablePadding: true }).encrypt(blocks);
    const hKey = encBlocks.subarray(0, 16);
    const tagMask = encBlocks.subarray(16, 32);
    const ctr0 = new Uint8Array(16);
    ctr0.set(nonce, 0);
    ctr0[15] = 2;
    try {
        if (encrypt) {
            const ct = ctr(key, ctr0).encrypt(data);
            const tag = computeTag(hKey, tagMask, aad, ct, tagBytes);
            const out = new Uint8Array(ct.length + tagBytes);
            out.set(ct, 0);
            out.set(tag, ct.length);
            return out;
        }
        if (data.length < tagBytes) throw new Error("aes192-gcm: short ciphertext");
        const ct = data.subarray(0, data.length - tagBytes);
        const givenTag = data.subarray(data.length - tagBytes);
        const expectedTag = computeTag(hKey, tagMask, aad, ct, tagBytes);
        const ok = equalBytes(expectedTag, givenTag);
        expectedTag.fill(0);
        if (!ok) throw new Error("aes192-gcm: invalid tag");
        return ctr(key, ctr0).decrypt(ct);
    } finally {
        hKey.fill(0);
        tagMask.fill(0);
    }
}
