import argon2Umd from "file://../../../node_modules/hash-wasm/dist/argon2.umd.min.js";

const ARGON_MEMORY_KIB = 65536;
const ARGON_PASSES = 3;
const MASTER_LEN = 32;

const WORKER_TAIL = `
self.onmessage = async (ev) => {
    const pw = new Uint8Array(ev.data.password);
    const salt = new Uint8Array(ev.data.salt);
    try {
        const out = await self.hashwasm.argon2id({
            password: pw,
            salt,
            parallelism: 1,
            iterations: ${ARGON_PASSES},
            memorySize: ${ARGON_MEMORY_KIB},
            hashLength: ${MASTER_LEN},
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

export async function deriveKeyRawInWorker(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array | null> {
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
            worker.postMessage({ password: pwBuf, salt: saltBuf }, [pwBuf, saltBuf]);
        });
    } catch {
        workerBlocked = true;
        return null;
    } finally {
        worker?.terminate();
        if (url) URL.revokeObjectURL(url);
    }
}
