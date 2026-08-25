# Woolly fork — change map for the pictureframes nexus

Fork base: upstream No-Instructions/Relay @ `6ed0db8` ("fix: resolve files
by TFile identity and stop minting at moved paths"). Everything after that
commit is Woolly work. `main` on this repo is the BRAT dist channel (built
bundle only); this `source` branch is the real tree + Woolly commit history, replayed
onto a snapshot root (upstream history couldn't be pushed: its commits
touch .github/workflows and the repo token lacks workflow scope — full
upstream history is at github.com/No-Instructions/Relay; original Woolly
SHAs noted in the commit map below).

## The sync-lag / read-only-folder rework (what you asked for)

The architecture: the vault splits into a small set of interactive rooms
(full Relay CRDT, bidirectional) and everything else (~90% of files), which
is served READ-ONLY over a separate one-way content-addressed mirror
protocol — no Yjs docs for those files at all. That is what kills the
vault-open lag: the per-doc merge-state walk at startup only covers the
interactive minority. Plugin-side, the rework is exactly two files:

- `src/MirrorSync.ts` — NEW. The entire mirror client: manifest pull on
  startup/login/5-min timer, blob-by-hash downloads (concurrency 6),
  vault-layer writes so the metadata cache indexes mirror files at write
  time, never uploads, deletes only paths it wrote (own state file, not
  data.json), prunes emptied ancestor folders, ETag/If-None-Match 304
  handling, status-bar heartbeat text.
- `src/main.ts` — wiring only: construct/start MirrorSync, a status-bar
  item, two commands ("Mirror: pull now", "Mirror: status"), a teardown
  step. Everything else in main.ts predates the rework.

The classifier (which rooms are CRDT vs mirror) lives HUB-SIDE ONLY, as an
explicit config list — the plugin has no folder-name semantics; it mounts
whatever shared folders exist and mirrors whatever the manifest serves.
Unlisted rooms default to mirror.

## Server contract (hub side is NOT in this repo)

The mirror server is ~200 lines inside the deployment's relay-daemon
(node), beside its CRDT folder syncing:

- `GET /mirror/manifest` → `{v:1, generatedAt, files:{"<path>":{h:<sha256>,
  s:<bytes>}}}`; `ETag` fingerprints the files map only; honors
  `If-None-Match` with 304.
- `GET /mirror/blob/<sha256-hex>` → raw bytes, `Content-Length` + `ETag`;
  409 when disk moved since the manifest snapshot (client re-pulls the
  manifest next beat).
- Auth on both: the PocketBase user session token as `Bearer`, validated
  via PB auth-refresh, cached ~10 min. Server keeps a stat-cache hash index
  (size+mtime fast path) rebuilt on request with a 15s cooldown.

## Commit map (mirror rework vs unrelated iteration)

- `8b5ac5a` (orig 3dc498f) — MIXED: MirrorSync v1 + the previously-uncommitted 0.1.1 fork
  state (operator gating via env-injected `RELAY_FORK_OPERATOR` →
  `src/operator.ts`, minimal settings surface in `LoggedIn.svelte` /
  `PluginSettings.svelte` / `WelcomeFooter.svelte` / `WelcomeHeader.svelte`,
  `LiveViews.ts` / `PublicAPI.ts` / `UpdateManager.ts` trims,
  env-injected fork URLs in `esbuild.config.mjs`). The 0.1.1 material is
  NOT part of the read-only rework — read `src/MirrorSync.ts` +
  `src/main.ts` hunks only.
- `f718999` (orig 02c3731) — mirror heartbeat (status bar + Mirror: status command).
- `853569a` (orig da46060) — prune empty ancestor folders after mirror deletions.
- `a365b48` (orig a7a0b56) — indexed writes via the Vault API (metadata-cache visibility),
  loud prune logging, ETag client. Current release: 0.2.3.

## Known-open (plugin side)

- Desktop husk-folder pruning failure under 0.2.2 — root cause pending the
  0.2.3 loud logs (may already be fixed by the vault-layer delete path).
- Local edits to mirror files revert only when the hub copy next changes
  (accepted v1 semantic; hub regeneration is the enforcement backstop).
