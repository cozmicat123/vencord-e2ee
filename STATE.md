# STATE.md: shared memory. The lead reads this first.
Next: clone Aegires (gen3), cozmicat123/aliucord-e2ee (aegires-sync), and cozmicat123/valenced-e2ee into ~/vc-work; inspect structure, crypto primitives, wire format, and licenses.

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
## Facts
- VDE fetches SharedPreferences "settings"."vencordLocation" (default vde-builds.nin0.dev/vencord/browser.js, Constants.kt:4); custom URLs always redownload (HttpClient.kt:41-53) and inject in onPageStarted (VWebviewClient.kt:31-32).
- VDE targetSdk 34 (app/build.gradle:13) omits usesCleartextTraffic/networkSecurityConfig (AndroidManifest.xml:8-15); custom vencordLocation must be public HTTPS (no auth headers, no http://localhost).
- Include VendroidEnhanced/plugin in custom VDE browser.js builds so the in-app vencordLocation UI remains accessible (uses window.VencordMobileNative.setString).
## Decisions
- Phone testing: build Vencord browser.js with our plugin (+ VendroidEnhanced/plugin), host over HTTPS, point VDE vencordLocation to it. Git user.email set to GitHub noreply.
## Log
- 2026-11-21: Verified VDE bundle loading (upstream is nin0/VendroidEnhanced, not astra1dev/Vendroid) and set git noreply email.
