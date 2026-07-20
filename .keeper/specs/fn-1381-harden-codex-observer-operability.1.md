## Description

**Size:** S
**Files:** integrations/pi-codex-pool/src/observer.ts, integrations/pi-codex-pool/test/observer.test.ts

### Approach

The observer command resolves the pi-ai provider catalog today by walking
PATH entries looking for a literal `pi` executable and importing
`node_modules/@earendil-works/pi-ai/dist/providers/all.js` relative to the
resolved package root. On the daemon's LaunchAgent PATH no `pi` file exists
(the real CLI lives under an nvm version dir), so `loadInstalledCodexOAuth`
throws and every invocation returns the `pool-unavailable` envelope. The
contract after this task: the observer resolves the catalog through an
ordered chain that does not require a PATH `pi` — (1) an explicit
`KEEPER_PI_CODEX_CATALOG_DIR`-style override when set, (2) resolution
relative to the observer's own package root (the bun-linked global install
and the repo checkout both place the pool package where a sibling/parent
lookup can be defined deterministically — verify what the installed layout
actually offers before committing to the rule), (3) the existing PATH scan
as the final fallback. Failure of the whole chain keeps the current bounded
unavailable envelope. Every probe stays read-only and diagnostics stay
non-exposing, matching the current catch-and-continue style.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- integrations/pi-codex-pool/src/observer.ts:200-238 — loadInstalledCodexOAuth PATH scan + catalog import
- integrations/pi-codex-pool/src/observer.ts:241-275 — runObserverCommand gates (KEEPER_JOB_ID, alias env, catch-all envelope)
- integrations/pi-codex-pool/test/observer.test.ts — existing observer test seams

**Optional** (reference as needed):
- ~/.bun/bin/keeper-pi-codex-observe — the bun-link symlink whose target dir shape the package-relative rule must handle
- src/account-routing-config.ts:144-153 — how keeperd resolves the observer command (env override precedent)

### Risks

The installed (bun-link) layout and the in-repo layout may differ in where
pi-ai is reachable; the package-relative rule must be verified against both
or the override key becomes the primary fix.

### Test notes

Unit-test the resolution chain through an injectable seam (env override
hit, package-relative hit, PATH fallback hit, full-chain miss) without
spawning real processes.

## Acceptance

- [ ] Running the installed observer under a minimal PATH containing no `pi` executable emits a real observation envelope for the configured aliases
- [ ] An explicit catalog-dir override env var is honored ahead of discovery
- [ ] Full-chain resolution failure still emits the bounded unavailable envelope, never a crash or partial output
- [ ] Focused observer tests cover all four chain outcomes and pass

## Done summary
Observer now resolves the pi-ai codex catalog via an ordered chain (KEEPER_PI_CODEX_CATALOG_DIR override, package-relative lookup, home bun/nvm package-manager scan, then legacy PATH scan) so it no longer hard-depends on a literal pi executable on PATH; full-chain failure still yields the bounded pool-unavailable envelope. Verified end-to-end against the real repo checkout under a minimal PATH.
## Evidence
