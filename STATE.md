# STATE.md: shared memory. The lead reads this first.
Next: shallow-clone Vendicated/Vencord (@ a846785 or latest) and VendroidEnhanced/plugin into ~/vc-work, verify build toolchain (Termux vs GitHub Actions), check Vencord license Next: clone Aegires (gen3), cozmicat123/aliucord-e2ee (aegires-sync), and cozmicat123/valenced-e2ee into ~/vc-work; inspect structure, crypto primitives, wire format, and licenses. human-written plugin hooks/APIs (MessageEvents, MessageAccessories, FileUpload, Flux), and benchmark Argon2id + AES-192-GCM libraries against Aegires Java vectors.

## Setup
- Repo: ~/vc-work/e2ee (branch dev) = github.com/cozmicat123/vencord-e2ee (private). Pack helper: ~/vc-work/pack.sh NAME files... -> ~/storage/downloads/pack-NAME.txt
- Device: OnePlus 12, Termux, git and gh already authorised.
- Test target: Vendroid Enhanced on phone; desktop via community testers.

## Leads (pointers, NOT facts: verify)
1. Chromium (Discord desktop, Android WebView) rejects 192-bit AES keys in WebCrypto: https://chromium.googlesource.com/chromium/src.git/+/fafff21/components/webcrypto/algorithms/aes.cc -> check how Aegires' 192-bit preset can be done.
2. Vendroid Enhanced loads the Discord mobile site and injects Vencord: https://github.com/astra1dev/Vendroid
3. Custom plugins need a source build of Vencord: https://docs.vencord.dev/installing/custom-plugins/ ; Vesktop can be pointed at a custom Vencord location (https://github.com/D3SOX/vencord-userplugins).
4. Termux build risk (Rollup android-arm64 native module): https://github.com/npm/cli/issues/8564 ; fallback = GitHub Actions build.
5. @noble/hashes Argon2 is pure JS (2-10x slower than native per its source comment): measure on the phone at Aegires' parameters.
6. Sharing a built Vencord+plugin = distribution; Vencord is GPL (unconfirmed): decide the repo licence before sharing.

## Pins
- VendroidEnhanced: git.nin0.dev/nin0/VendroidEnhanced @ 50c0ae0 (vde-builds browser.js = Vendicated/Vencord @ a846785 + VendroidEnhanced/{plugin,vendroidSheets,vendroidEnhancements,materialYou})
- Aegires: ~/Aegires (gen3 @ f44d575); siblings: ~/vc-work/aliucord-e2ee (aegires-sync @ 6cc9b1d), ~/vc-work/valenced-e2ee (main @ 1274e88, valenced-port @ d3808aa)
## Facts
- VDE fetches SharedPreferences "settings"."vencordLocation" (Constants.kt:4); custom URLs always redownload (HttpClient.kt:41-53) and inject in onPageStarted (VWebviewClient.kt:31-32). targetSdk 34 omits cleartext (AndroidManifest.xml:8-15) -> public HTTPS required. Include VendroidEnhanced/plugin so settings UI stays available.
- Discord live CSP: script-src includes 'unsafe-eval' and blob: (allows WebAssembly + inline Blob Workers without browser flags); connect-src allows Discord CDN/media hosts.
- Aegires wire protocol (Crypto.java, Argon2id.java, Blake2b.java, ForcedKeys.java, FileNames.java):
  - KDF: NFKC password -> UTF-8 -> Argon2id v1.3 (RFC 9106, type=2, p=1, t=3, m=65536 KiB, 32B out). Salt: "dcenc2|user-key|v1" or "dcenc2|ctx|forced|<channelId>". Forced preset: ch 1378767422638522404 -> "breadtastesbetterthankey".
  - Presets: 0=AES-128-GCM (16B key, 12B tag, 16B pad), 1=AES-192-GCM (24B key, 14B tag, 32B pad), 2=AES-256-GCM (32B key, 16B tag, 64B pad).
  - Msg wire (v2): "\u00A7" + unpadded StdBase64([header=(2<<4)|preset, salt(16B), gcmCt+tag]). ISO 7816-4 pad (0x80 + 0x00* to padBlock). HKDF-SHA256(salt, master, info="dcenc2/msg"+preset+u16be(chLen)+ch+u16be(seLen)+se) -> key+nonce(12B); AAD=header+salt+info. Replies decrypt with replyChannel||channelId + replyAuthorId; optional leading "[sz:W,H]" stripped on decrypt and prepended on image upload.
  - File wire (v3): [header=(3<<4)|preset, salt(16B), chunks...]. 64 KiB chunks; HKDF info="dcenc2/file"+... -> key+prefix(7B); chunk nonce = prefix(7B)+u32be(counter)+lastFlag(1B); AAD=header+salt+info. Filename: FileNames.randomFor() + ".enc" before ext; detected via contains(".enc.") || endsWith(".enc").
- Termux tools available: node v26.13.1, npm 12.2.2, java/javac 21.0.13 (can run Aegires Java for test vectors), python3 3.14, clang 21, rustc 1.100; pnpm/corepack missing.
## Decisions
- Single-agent workflow (Gemini sole worker, AGENTS.md updated). Private repo; author permission granted for 1:1 Aegires port.
- Phone testing: build Vencord browser.js (+ VendroidEnhanced/plugin), host over HTTPS, point VDE vencordLocation to it. Git user.email = GitHub noreply.
## Log
- 2026-11-21: Verified VDE bundle loading, Discord CSP, Termux toolchain, and full Aegires gen3 E2EE wire/message/file protocol.
