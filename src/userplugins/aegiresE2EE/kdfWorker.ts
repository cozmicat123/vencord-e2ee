import argon2Umd from "file://../../../node_modules/hash-wasm/dist/argon2.umd.min.js";

import type { ArgonParams } from "./crypto";

type Argon2Fn = (opts: {
    password: Uint8Array;
    salt: Uint8Array;
    parallelism: number;
    iterations: number;
    memorySize: number;
    hashLength: number;
    outputType: "binary";
}) => Promise<Uint8Array>;

const WORKER_TAIL = `
self.onmessage = async (ev) => {
    const pw = new Uint8Array(ev.data.password);
    const salt = new Uint8Array(ev.data.salt);
    const p = ev.data.params;
    try {
        const out = await self.hashwasm.argon2id({
            password: pw,
            salt,
            parallelism: p.parallelism,
            iterations: p.iterations,
            memorySize: p.memorySize,
            hashLength: p.hashLength,
            outputType: "binary"
        });
        const copy = new Uint8Array(out);
        self.postMessage({ ok: true, buffer: copy.buffer }, [copy.buffer]);
    } catch (err) {
        self.postMessage({ ok: false, error: String(err) });
    } finally {
        pw.fill(0);
    }
};
`;

let workerBlocked = false;
let fallbackArgon2id: Argon2Fn | null = null;

function getFallbackArgon2id(): Argon2Fn | null {
    if (fallbackArgon2id) return fallbackArgon2id;
    try {
        const exportsObj: { argon2id?: Argon2Fn; } = {};
        const mod = { exports: exportsObj };
        new Function("exports", "module", argon2Umd)(exportsObj, mod);
        fallbackArgon2id = exportsObj.argon2id ?? null;
        return fallbackArgon2id;
    } catch {
        return null;
    }
}

async function runInWorker(password: Uint8Array, salt: Uint8Array, params: ArgonParams): Promise<Uint8Array | null> {
    if (workerBlocked || typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
        return null;
    }

    let url: string | null = null;
    let worker: Worker | null = null;

    try {
        const blob = new Blob([argon2Umd, "\n", WORKER_TAIL], { type: "application/javascript" });
        url = URL.createObjectURL(blob);
        worker = new Worker(url);

        const pwBuf = password.slice().buffer;
        const saltBuf = salt.slice().buffer;

        return await new Promise<Uint8Array | null>(resolve => {
            if (!worker) return resolve(null);
            worker.onmessage = (ev: MessageEvent<{ ok: boolean; buffer?: ArrayBuffer; }>) => {
                if (ev.data?.ok && ev.data.buffer) {
                    resolve(new Uint8Array(ev.data.buffer));
                } else {
                    resolve(null);
                }
            };
            worker.onerror = () => {
                workerBlocked = true;
                resolve(null);
            };
            worker.postMessage({ password: pwBuf, salt: saltBuf, params }, [pwBuf, saltBuf]);
        });
    } catch {
        workerBlocked = true;
        return null;
    } finally {
        worker?.terminate();
        if (url) URL.revokeObjectURL(url);
    }
}

export async function deriveKeyRawInWorker(password: Uint8Array, salt: Uint8Array, params: ArgonParams): Promise<Uint8Array | null> {
    try {
        const workerOut = await runInWorker(password, salt, params);
        if (workerOut) return workerOut;

        const fn = getFallbackArgon2id();
        if (!fn) return null;
        return await fn({
            password,
            salt,
            parallelism: params.parallelism,
            iterations: params.iterations,
            memorySize: params.memorySize,
            hashLength: params.hashLength,
            outputType: "binary"
        });
    } finally {
        password.fill(0);
    }
}
