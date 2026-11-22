# STATE.md: shared memory. Read first on "start".
Next: Maintenance & post-v1.0.0 fixes (verify signed .xpi install on Firefox/Iceraven and [sz:W,H] rendering in Aegires).

## Setup & Pins
- Repo: ~/vc-work/e2ee (branch `dev`, public) = github.com/cozmicat123/vencord-e2ee.
- Rolling `builds` branch URLs (auto-published by CI on `dev`/`main` push):
  - VDE: `https://raw.githubusercontent.com/cozmicat123/vencord-e2ee/builds/browser.js`
  - Clean Userscript: `https://raw.githubusercontent.com/cozmicat123/vencord-e2ee/builds/Vencord.user.js`
- Rolling GitHub Prerelease `nightly` + `v*` tag releases host separate binaries: clean `extension-chrome.zip`, `extension-firefox.zip`, `Vencord.user.js`, and VDE-only `vendroid-browser.{js,css,js.LEGAL.txt}` + `SHA256SUMS.txt`.
- Device: OnePlus 12, Termux (node 26, npm 12, java 21, python3, gh authed). No PC; CI runs pnpm/Vencord builds.
- Vencord: Vendicated/Vencord @ a846785 (v1.15.18, GPL-3.0-or-later, pnpm 12.15.0).
- VendroidEnhanced: app @ 50c0ae0 (`~/vc-work/vde-app`), plugin @ 3741bd8 (`~/vc-work/vde-plugin`).
- Aegires: `~/Aegires` (gen3 @ f44d575). Siblings: `~/vc-work/aliucord-e2ee`, `~/vc-work/valenced-e2ee`.

## Architecture Invariants (Keep Clean - No Scaffolding / Duct Tape)
- Strict top-down module DAG (zero circular imports):
  `gcm192 / sizeTag / fileNames` -> `crypto` -> `forcedKeys` -> `state` -> `engine` -> `ui` -> `settings` -> `index` (`kdfWorker` type-only -> `crypto`; `diagnostics` -> `crypto`, `kdfWorker`; `settings` -> `diagnostics`).
- Pure crypto core (`crypto.ts`, `gcm192.ts`, `fileNames.ts`, `sizeTag.ts`, `forcedKeys.ts`) has zero Vencord/DOM/React imports and zero static `hash-wasm` import; KDF provider is injected (`setRawKdfProvider`), so bundles ship only ONE Argon2id WASM binary (`kdfWorker.ts`).
- `kdfWorker.ts`: single-use Blob Worker terminates immediately after Argon2id to drop the 64 MiB WASM heap; lazy UMD `Function` fallback if CSP blocks `blob:` workers.
- `engine.ts`: batched `MessageCache.commit` + `MessageStore.emitChange` (12ms window -> 1 render per channel batch), immutable `WireRecord` snapshots, LRU-bounded (2000) + `MESSAGE_DELETE`/`MESSAGE_DELETE_BULK` cleanup, `decryptEpoch` race guard, fail-closed send/edit encryption.
- `index.tsx`: uses `managedStyle` (`./styles.css?managed`) because VDE's `vencord_mobile.js:44` hardcodes `browser.css` to `vde-builds.nin0.dev` and ignores custom `browser.css`.
- Dual CI build invariant: clean upstream Vencord (`extension-chrome.zip`, `extension-firefox.zip`, `Vencord.user.js`) is built BEFORE applying VDE plugins/blacklist (`vendroid-browser.*` / `builds/browser.js`), so non-VDE browsers never get the Android-only `VendroidEnhanced Settings` tab.
- Milestone 4 design rule: offload v3 file encrypt/decrypt (especially AES-192-GCM pure JS) to a Worker with zero-copy transferable `ArrayBuffer`s, and always revoke `URL.createObjectURL` blobs on unmount/key-clear/stop.

## Verified Protocol & Platform Facts
- VDE custom bundle: `Developer settings -> Vencord location` fetches direct HTTPS URL (`HttpClient.kt:41-54`, redownloads on launch, rejects HTTP >= 300).
- Discord live CSP: `script-src` allows `'unsafe-eval'` + `blob:`; `child-src` allows `'self' blob:`.
- KDF: NFKC -> UTF-8 -> Argon2id v1.3 (p=1, t=3, m=65536 KiB, 32B). Salt: `"dcenc2|user-key|v1"` or `"dcenc2|ctx|forced|<chId>"`. Forced preset channel: `1562876012675465326`.
- Presets: 0=AES-128-GCM (16B/12B tag/16B pad), 1=AES-192-GCM (24B/14B/32B, `@noble/ciphers` since Chromium WebCrypto rejects 192-bit), 2=AES-256-GCM (32B/16B/64B, default).
- Msg wire (v2): `"\u00A7"` + unpadded StdBase64(`[header=(2<<4)|preset, salt(16B), gcmCt+tag]`); ISO 7816-4 pad; HKDF info=`"dcenc2/msg"+preset+u16be(chLen)+ch+u16be(seLen)+se`; AAD=`header+salt+info`.
- File wire (v3): `[header=(3<<4)|preset, salt(16B), 64KiB chunks...]`; HKDF info=`"dcenc2/file"+...` -> key+prefix(7B); chunk nonce=`prefix+u32be(counter)+lastFlag(1B)`; filename=`<20hex>.enc.<ext>` (detected via `.enc.` or trailing `.enc`).

## Milestones
- M1-M2: Crypto core + 2-way Java<->TS vector suite (`tests/run.mjs`: 10 Java->TS msgs, 9 Java->TS files, 3 TS msgs, 9 TS files) — DONE.
- M3: Full Vencord plugin (chat bar lock, modal, badge, Flux decrypt, reply previews, forced keys, off-thread KDF, on-demand JIT/WASM/HWA diagnostics) verified live against Aegires Android on all presets + optimized + dual CI builds (`nightly` + `builds`) — DONE.
- Live cross-platform bench verified (Titanium Chrome/157, VDE Vanadium Chrome/155 wv, Iceraven Gecko/160 + VM, Firefox Android Gecko/163 native ext): full JIT, Blob Worker WASM Argon2id (215-402ms), hardware WebCrypto AES-128/256 (143-1111 MiB/s), pure-JS AES-192 (9.4-31.9 MiB/s).

- M4: Encrypted file/media attachments (v3 64KiB chunked wire in Worker with transferable ArrayBuffers, pre-upload `CloudUpload.prototype.upload` hook in `d8aed97` to prevent CDN plaintext leaks, `[sz:W,H]` dimension preservation in `114fbcf`, inline decrypt + blob URL cleanup, AMO unlisted Firefox `.xpi` signing on `v*` tags) — DONE.
- v1.0.0: Merged `dev` -> `main` (`4f294b2`) and published stable release with all 8 assets including AMO-signed `vencord-e2ee-firefox-signed.xpi` — DONE.
