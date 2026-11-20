# STATE.md: shared memory. The lead reads this first.
Next: find out how Vendroid Enhanced gets its Vencord JS and whether a custom bundle can be loaded (clone astra1dev/Vendroid into ~/vc-work, pack the relevant files, read them). Also arrange once: owner's real GitHub noreply email for git config user.email (commit 3f2ede2 has a placeholder email; leave it).

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
## Facts
## Decisions
## Log
