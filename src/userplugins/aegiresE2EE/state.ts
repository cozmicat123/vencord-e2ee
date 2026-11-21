import { showToast, useEffect, useState } from "@webpack/common";

import { DEFAULT_PRESET, deriveKey, type MasterKey, type Preset, presetFromIndex } from "./crypto";
import { isForced, keyFor } from "./forcedKeys";
import { settings } from "./settings";

export interface E2EESnapshot {
    hasKey: boolean;
    enabled: boolean;
    deriving: boolean;
}

let userKey: MasterKey | null = null;
let userEnabled = false;
let deriving = false;
let derivationGen = 0;

const listeners = new Set<() => void>();
let onKeyChangedCallback: ((reason: "set" | "clear") => void) | null = null;

function notify() {
    for (const fn of listeners) fn();
}

export function setOnKeyChanged(cb: ((reason: "set" | "clear") => void) | null): void {
    onKeyChangedCallback = cb;
}

export function getSnapshot(): E2EESnapshot {
    return {
        hasKey: userKey !== null,
        enabled: userEnabled,
        deriving
    };
}

export function subscribeState(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function useE2EEState(): E2EESnapshot {
    const [snap, setSnap] = useState<E2EESnapshot>(getSnapshot);
    useEffect(() => subscribeState(() => setSnap(getSnapshot())), []);
    return snap;
}

export function getUserKey(): MasterKey | null {
    return userKey;
}

export function getSelectedPreset(): Preset {
    return presetFromIndex(Number(settings.store.preset)) ?? DEFAULT_PRESET;
}

export function getEffectiveKey(channelId: string | null | undefined): MasterKey | null {
    if (isForced(channelId)) return keyFor(channelId);
    return userKey;
}

export function shouldEncryptChannel(channelId: string | null | undefined): boolean {
    if (isForced(channelId)) return true;
    return userKey !== null && userEnabled;
}

export function toggleUserEnabled(): boolean {
    if (!userKey) return false;
    userEnabled = !userEnabled;
    notify();
    showToast({
        text: userEnabled ? "Encryption enabled" : "Encryption disabled",
        variant: userEnabled ? "success" : undefined
    });
    return userEnabled;
}

export function setUserEnabled(val: boolean): void {
    if (!userKey && val) return;
    userEnabled = val;
    notify();
}

export async function deriveAndSetUserKey(password: string): Promise<boolean> {
    if (!password) return false;
    const hadKey = userKey !== null;
    const gen = ++derivationGen;
    deriving = true;
    notify();
    showToast({ text: "Deriving key, this takes a few seconds..." });

    const key = await deriveKey(password);
    if (gen !== derivationGen) return false;

    deriving = false;
    if (!key) {
        notify();
        showToast({
            text: hadKey ? "Key derivation failed; previous key still active" : "Key derivation failed (not enough memory?)",
            variant: "critical"
        });
        return false;
    }

    userKey = key;
    userEnabled = true;
    notify();
    showToast({ text: "Encryption enabled for this session", variant: "success" });
    onKeyChangedCallback?.("set");
    return true;
}

export function clearUserKey(silent = false): void {
    derivationGen++;
    userKey = null;
    userEnabled = false;
    deriving = false;
    notify();
    if (!silent) {
        showToast({ text: "Encryption disabled" });
    }
    onKeyChangedCallback?.("clear");
}
