import { decrypt, decryptBytes, deriveKey, encrypt, encryptBytes, PRESET_LIST } from "./crypto";
import { getLastKdfMode } from "./kdfWorker";

const FILE_BENCH_BYTES = 1024 * 1024; // 1 MiB

function runJitProbe(): number {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 20_000_000; i++) x = (x + i) | 0;
    if (x === -1) console.debug(x);
    return performance.now() - t0;
}

export async function runDiagnostics(): Promise<string> {
    const lines: string[] = [];
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
    const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? "?") : "?";

    lines.push(`UA: ${ua}`);
    lines.push(`Cores: ${cores} | WASM: ${typeof WebAssembly !== "undefined"} | Worker: ${typeof Worker !== "undefined"} | Subtle: ${Boolean(globalThis.crypto?.subtle)}`);

    const jitMs = runJitProbe();
    const jitTag = jitMs < 40 ? "JIT active" : "slow / JIT-less";
    lines.push(`JS JIT probe (20M loop): ${jitMs.toFixed(1)} ms (${jitTag})`);

    const tKdf = performance.now();
    const key = await deriveKey("aegires-bench-passphrase");
    const kdfMs = performance.now() - tKdf;
    const mode = getLastKdfMode();
    if (!key) {
        lines.push(`Argon2id KDF: FAILED (${kdfMs.toFixed(1)} ms, mode=${mode})`);
        return lines.join("\n");
    }
    lines.push(`Argon2id KDF (64MiB t=3 p=1): ${kdfMs.toFixed(1)} ms (mode=${mode})`);

    const sample = new Uint8Array(FILE_BENCH_BYTES);
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 31 + 17) & 0xff;

    for (const preset of PRESET_LIST) {
        const wires = await Promise.all(
            Array.from({ length: 50 }, (_, i) => encrypt(`Benchmark msg #${i}`, key, preset, "123456", "789012"))
        );
        const validWires = wires.filter((w): w is string => w !== null);
        const tMsg = performance.now();
        await Promise.all(validWires.map(w => decrypt(w, key, "123456", "789012")));
        const msgMs = performance.now() - tMsg;

        const tEnc = performance.now();
        const encBuf = await encryptBytes(sample, key, preset, "123456", "789012");
        const encMs = performance.now() - tEnc;

        let decMs = -1;
        if (encBuf) {
            const tDec = performance.now();
            await decryptBytes(encBuf, key, "123456", "789012");
            decMs = performance.now() - tDec;
        }

        const decMibS = decMs > 0 ? (1000 / decMs).toFixed(1) : "ERR";
        lines.push(`${preset.label}: 50-msg=${msgMs.toFixed(1)}ms | 1MiB enc=${encMs.toFixed(1)}ms dec=${decMs.toFixed(1)}ms (${decMibS} MiB/s)`);
    }

    return lines.join("\n");
}
