import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
    resolve(specifier, context, next) {
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier) && context.parentURL) {
            const p = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
            if (fs.existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
        }
        return next(specifier, context);
    }
});

const cryptoMod = await import("../src/userplugins/aegiresE2EE/crypto.ts");
const { argon2id } = await import("hash-wasm");
cryptoMod.setRawKdfProvider((password, salt, p) => argon2id({ password, salt, parallelism: p.parallelism, iterations: p.iterations, memorySize: p.memorySize, hashLength: p.hashLength, outputType: "binary" }));
const forcedMod = await import("../src/userplugins/aegiresE2EE/forcedKeys.ts");
const fileNamesMod = await import("../src/userplugins/aegiresE2EE/fileNames.ts");
const sizeTagMod = await import("../src/userplugins/aegiresE2EE/sizeTag.ts");
const vec = JSON.parse(fs.readFileSync("tests/aegires-vectors.json", "utf8"));
const b64 = u => Buffer.from(u).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
const pattern = len => Uint8Array.from({ length: len }, (_, i) => (i * 31 + 17) & 0xff);

// 1. KDF vectors (user, NFKC, forced)
const rawUser = await cryptoMod.deriveKeyRaw(vec.keys.user.password);
assert.equal(b64(rawUser), vec.keys.user.rawB64, "user KDF mismatch");
const rawNfkc = await cryptoMod.deriveKeyRaw(vec.keys.nfkc.password);
assert.equal(b64(rawNfkc), vec.keys.nfkc.rawB64, "NFKC KDF mismatch");
const rawForced = await cryptoMod.deriveKeyRaw("mojoen", "forced|" + vec.keys.forced.channelId);
assert.equal(b64(rawForced), vec.keys.forced.rawB64, "forced KDF mismatch");
const kUser = await cryptoMod.importMasterKey(rawUser);

// 2. Sizes
const fSizes = [0, 1, 65536, 65537, 140000];
for (const p of cryptoMod.PRESET_LIST) {
    assert.equal(cryptoMod.maxPlaintextBytes(p), vec.sizes[p.name].maxPlain, p.name + " maxPlain");
    assert.deepEqual(fSizes.map(s => cryptoMod.fileOverhead(p, s)), vec.sizes[p.name].overhead, p.name + " overhead");
}

// 3. ForcedKeys
assert.equal(forcedMod.isForced(vec.keys.forced.channelId), true);
assert.equal(forcedMod.isForced("12345"), false);
const kForced = await forcedMod.prepare(vec.keys.forced.channelId);
assert.ok(kForced && forcedMod.keyFor(vec.keys.forced.channelId) === kForced);

// 4. Java -> TS messages + negative checks
for (const m of vec.messages) {
    const key = m.key === "forced" ? kForced : kUser;
    assert.equal(cryptoMod.looksEncrypted(m.wire), true);
    assert.equal(await cryptoMod.decrypt(m.wire, key, m.ch, m.se), m.plain, "msg " + m.preset);
    assert.equal(await cryptoMod.decrypt(m.wire, key, m.ch + "0", m.se), null, "wrong ch");
    assert.equal(await cryptoMod.decrypt(m.wire, key, m.ch, m.se + "0"), null, "wrong se");
}
const overMax = "a".repeat(cryptoMod.maxPlaintextBytes(cryptoMod.PRESETS.AES256) + 1);
assert.equal(await cryptoMod.encrypt(overMax, kUser, cryptoMod.PRESETS.AES256, "1", "2"), null);

// 5. Java -> TS files + tamper check
for (const f of vec.files) {
    const wire = unb64(f.wireB64);
    const dec = await cryptoMod.decryptBytes(wire, kUser, f.ch, f.se);
    assert.ok(dec, "file " + f.preset + " len=" + f.len);
    assert.equal(Buffer.compare(dec, pattern(f.len)), 0, "file bytes " + f.preset + " len=" + f.len);
    const bad = wire.slice(); bad[bad.length - 1] ^= 1;
    assert.equal(await cryptoMod.decryptBytes(bad, kUser, f.ch, f.se), null, "tamper file");
}

// 6. TS roundtrip + emit for Java verification
const tsOut = { messages: [], files: [] };
for (const p of cryptoMod.PRESET_LIST) {
    const plain = `[sz:800,600]TS->Java ${p.name} \u4E16\u754C \uD83D\uDD10`;
    const wire = await cryptoMod.encrypt(plain, kUser, p, "123456789012345678", "987654321098765432");
    assert.ok(wire && wire.length <= 2000);
    assert.equal(await cryptoMod.decrypt(wire, kUser, "123456789012345678", "987654321098765432"), plain);
    tsOut.messages.push({ preset: p.name, ch: "123456789012345678", se: "987654321098765432", plain, wire });

    for (const len of [0, 65536, 140000]) {
        const pt = pattern(len);
        const fw = await cryptoMod.encryptBytes(pt, kUser, p, "123456789012345678", "987654321098765432");
        assert.ok(fw);
        const dec = await cryptoMod.decryptBytes(fw, kUser, "123456789012345678", "987654321098765432");
        assert.equal(Buffer.compare(dec, pt), 0);
        tsOut.files.push({ preset: p.name, ch: "123456789012345678", se: "987654321098765432", len, wireB64: b64(fw) });
    }
}

// 7. FileNames & SizeTag
assert.match(fileNamesMod.randomFor("pic.PNG", "image/png"), /^[0-9a-f]{20}\.png$/);
assert.match(fileNamesMod.randomFor("doc.TAR.GZ", ""), /^[0-9a-f]{20}\.gz$/);
assert.match(fileNamesMod.randomFor("file.toolongext", ""), /^[0-9a-f]{20}$/);
assert.equal(fileNamesMod.addEncSuffix("a.png"), "a.enc.png");
assert.equal(fileNamesMod.addEncSuffix("noext"), "noext.enc");
assert.equal(fileNamesMod.addEncSuffix(""), "file.enc");
assert.equal(fileNamesMod.isEncryptedFilename("abc.enc.png"), true);
assert.equal(fileNamesMod.isEncryptedFilename("abc.enc"), true);
assert.equal(fileNamesMod.isEncryptedFilename("abc.png"), false);
assert.deepEqual(sizeTagMod.extractSizeTag("[sz:1280,720]hi"), { width: 1280, height: 720, cleaned: "hi" });
assert.equal(sizeTagMod.cleanSizeTag("[sz:10,20]ok"), "ok");

if (process.argv.includes("--emit")) fs.writeFileSync(".tmp/ts-out.json", JSON.stringify(tsOut));
console.log("ALL TS TESTS PASSED:", vec.messages.length, "Java->TS msgs,", vec.files.length, "Java->TS files,", tsOut.messages.length, "TS msgs,", tsOut.files.length, "TS files");
