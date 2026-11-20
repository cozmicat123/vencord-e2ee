# STATE.md — the shared notes. Owner pastes only this file (or its tail) into a chat.

## Pins (from Termux output, not from memory)
Aegires:  
Vencord:  
Vendroid Enhanced version:  

## Test targets
- Owner: Vendroid Enhanced (Android WebView) on the phone.
- Desktop: community testers (owner has no desktop).

## Leads (curator's pointers, NOT facts: verify before relying)
1. Chromium (Discord desktop, Android WebView) rejects 192-bit AES keys in WebCrypto: https://chromium.googlesource.com/chromium/src.git/+/fafff21/components/webcrypto/algorithms/aes.cc -> check how Aegires' 192-bit preset can be done.
2. Vendroid Enhanced loads the Discord mobile site and injects Vencord: https://github.com/astra1dev/Vendroid -> find where it gets the Vencord JS and whether a custom build can be loaded.
3. Custom plugins need a source build of Vencord: https://docs.vencord.dev/installing/custom-plugins/ ; Vesktop can be pointed at a custom Vencord location (see https://github.com/D3SOX/vencord-userplugins) -> possible no-compile path for desktop testers.
4. Termux build risk (Rollup android-arm64 native module): https://github.com/npm/cli/issues/8564 ; fallback = GitHub Actions build.
5. @noble/hashes Argon2 is pure JS (source comment: 2-10x slower than native) -> measure on the phone at Aegires' parameters.
6. Sharing a built Vencord+plugin with testers = distribution; Vencord is GPL (SPDX header, unconfirmed) -> decide the repo licence before sharing.

## Facts (each = quoted line + path:line + pinned commit)

## Decisions

## Log (newest last: date — what is now known/decided — what is needed next)
