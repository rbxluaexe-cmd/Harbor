# Harbor

A privacy-first desktop browser built on Electron + TypeScript. Harbor wraps
Chromium and patches the privacy-relevant layers — the same pattern Brave,
Vivaldi, and Floorp follow — rather than pretending to ship a from-scratch
engine.

> **Scope.** Desktop (Windows/macOS/Linux) only. Mobile is explicitly out of
> scope: iOS forces WebKit (WKWebView) and Android's WebView can't expose the
> engine-level hooks this design relies on (raw `webRequest`, CDP injection,
> custom DNS). A mobile client is a separate, thinner build that would share the
> policy/config layer but not the engine features.

## Architecture

One feature per module under `src/main/`, talking only through a typed contract
and an internal event bus — no module reaches into another's internals.

```
src/
  main/
    network/      webRequest hooks, CNAME uncloaking, WebRTC policy, secure DNS
    identity/     compartment (partition) management
    fingerprint/  canvas/audio/webgl noise + navigator overrides via CDP
    sync/         zero-knowledge sync client (Argon2id + XChaCha20-Poly1305)
    ledger/       per-tab request log + runtime privacy score
    presets/      threat-model preset schema + loader (zod-validated)
    duress/       panic shortcut, decoy switch, fast wipe
    update/       signed update checks (Ed25519 verify)
    tabs/         the browser shell (BaseWindow + WebContentsView per tab)
    bus.ts        typed internal pub/sub so modules stay decoupled
    ipc-router.ts binds the contract to module methods; forwards events
  preload/        contextBridge exposure of the typed bridge only
  renderer/       tab bar, compartment switcher, ledger panel, settings
  ipc/            typed contract shared by every module (no electron/node imports)
```

Modules announce facts on the bus (e.g. `network:observation`) and subscribe to
the ones they need. The network module emits without knowing the ledger exists;
the ledger consumes without knowing where observations came from.

## Features

1. **Identity compartments** — each compartment is a distinct Chromium partition
   (`persist:` for durable, non-`persist:` for ephemeral), so storage isolation
   is enforced by the engine. New tabs default to an explicit ephemeral state.
2. **Fingerprint shielding** — patches canvas/audio/WebGL/navigator surfaces in
   the page's *main world* before any page script runs, via CDP
   `Page.addScriptToEvaluateOnNewDocument`. Noise is bounded and seed-derived per
   compartment per session, so reads stay self-consistent.
3. **WebRTC leak protection** — `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`
   per content view, forcing WebRTC off local-IP-leaking UDP paths without
   breaking calls outright.
4. **Network ledger** — per-tab request log translated to plain language, with a
   privacy score computed from observed runtime behaviour, not a static list.
5. **CNAME-uncloaked blocking** — resolves the CNAME chain of unfamiliar third
   parties and checks the canonical name against the blocklist too.
6. **Zero-knowledge sync** — Argon2id derives a master key split into separate
   encryption and auth subkeys; content is sealed with XChaCha20-Poly1305 before
   it leaves. The server only ever sees ciphertext + an auth token.
7. **Threat-model presets** — typed, versioned, zod-validated configs (Everyday /
   Journalist / Public terminal), not a single linear slider.
8. **Duress / panic mode** — a global hotkey wipes configured compartments and
   can switch to a decoy compartment.
9. **Secure DNS / private routing** — DoH via command-line switches (verify the
   switch names against your Chromium version); ODoH is scoped as its own phase
   behind a `session.setProxy` seam.
10. **Binary transparency** — pinned dependency versions, timestamp-free artifact
    names, and a signable `checksums.txt` manifest the update checker verifies.

## Develop

```bash
npm install
npm run build      # compiles renderer (ESM) then main/preload (CJS)
npm start          # build + launch
npm run typecheck  # strict-mode type check across the whole tree
```

Running as root (e.g. CI containers) requires `electron . --no-sandbox`.

## Packaging & transparency

```bash
npm run dist        # electron-builder, output in release/
npm run checksums   # SHA-256 manifest of release/ artifacts
minisign -Sm checksums.txt   # sign it out-of-band
```

Dependency versions are pinned (no `^`/`~`) and artifact names are
timestamp-free so two builds of the same source are comparable.

## Deliberately deferred

- Browser extension support (needs a permission re-consent model).
- Local privacy-policy summarizer (must be proven not to phone home first).
- Mobile clients (see Scope).

## Security notes

- The chrome UI runs with `contextIsolation: true` behind a strict CSP and loads
  no remote content; web pages live in separate, fully sandboxed
  `WebContentsView`s bound to their compartment session.
- All cryptography is libsodium; nothing is hand-rolled.
- The pinned release-signing public key in `src/main/update/index.ts` is a
  placeholder — replace it before publishing releases.
