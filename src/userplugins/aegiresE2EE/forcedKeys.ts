import { deriveKey, type MasterKey } from "./crypto";

const FORCED_PRESETS: Readonly<Record<string, string>> = {
    "1562876012675465326": "mojoen"
};

const derived = new Map<string, MasterKey>();
const pending = new Map<string, Promise<MasterKey | null>>();

export function isForced(channelId: string | null | undefined): boolean {
    return !!channelId && Object.prototype.hasOwnProperty.call(FORCED_PRESETS, channelId);
}

export function keyFor(channelId: string | null | undefined): MasterKey | null {
    return channelId ? derived.get(channelId) ?? null : null;
}

export function prepare(channelId: string | null | undefined): Promise<MasterKey | null> {
    if (!channelId || !isForced(channelId)) return Promise.resolve(null);
    const have = derived.get(channelId);
    if (have) return Promise.resolve(have);
    const inflight = pending.get(channelId);
    if (inflight) return inflight;
    const p = deriveKey(FORCED_PRESETS[channelId], "forced|" + channelId).then(k => {
        pending.delete(channelId);
        if (k) derived.set(channelId, k);
        return k;
    });
    pending.set(channelId, p);
    return p;
}

export function clearForcedKeys(): void {
    derived.clear();
    pending.clear();
}
