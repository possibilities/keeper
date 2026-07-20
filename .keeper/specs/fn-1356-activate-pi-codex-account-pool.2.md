## Description

**Size:** S
**Files:** scripts/install.sh, integrations/pi-codex-pool/package.json, docs/install.md

### Approach

The codex-pool activation ladder gates reload and verify through
`codexPoolObservationVerifies(candidate, inspectCodexRouting())`, and
`inspectCodexRouting` reads the account-routing observation envelope
(`~/.local/state/keeper/codex-account-routing/observation.json`) under a
90-second freshness ceiling. The sole writer is the CodexAccountObserver
spawning the observer executable that `resolveCodexObserverBin` returns —
the literal `keeper-pi-codex-observe` unless `KEEPER_PI_CODEX_OBSERVER_BIN`
overrides. That executable exists only as a package bin declaration in the
pi-codex-pool integration; no install path links it onto PATH, so the
observer can never run, the envelope is never written, and `activate`
always rolls back to native regardless of proof quality. Provision it:
install.sh installs/links an invocable `keeper-pi-codex-observe` (or
durably configures the override) so a marked environment can produce a
fresh observation. Prove resolution and envelope-writing through seams;
do not require the live daemon.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/account-routing-config.ts:145 — observer bin resolution (env override else literal name on PATH)
- integrations/pi-codex-pool/package.json:11 — the bin declaration (`keeper-pi-codex-observe` → ./src/observer.ts)
- scripts/install.sh — currently zero observer references; the provisioning home
- src/codex-account-observation* — the CodexAccountObserver spawn path and envelope write

**Optional** (reference as needed):
- integrations/pi-codex-pool/README.md:36 — the marked-environment invocation contract

### Risks

- The observer must run under a Keeper-marked environment; a PATH link alone may still need the marker plumbing the spawn path provides — verify the spawn context supplies it
- Pi-extension isolation: the linked executable's module graph must stay bun-free-compatible per the fn-1378 lint gate if it loads extension modules

### Test notes

Sandboxed: run the linked executable (or its module entry) against a per-test
state dir and assert the observation envelope lands with the expected shape;
a resolution test through the config seam proves PATH/override behavior.

## Acceptance

- [ ] A fresh install provisions an invocable `keeper-pi-codex-observe` (PATH link or durable override), covered by an install-surface check
- [ ] The observer executable, run in a sandboxed marked environment, writes a well-formed observation envelope to the routing state dir
- [ ] Observer-bin resolution is covered by a deterministic test through the config seam (override set, override empty, default name)

## Done summary
Provisioned keeper-pi-codex-observe onto PATH via bun link in install.sh (mirroring the keeper CLI's own link step, with a KEEPER_PI_CODEX_OBSERVER_BIN override escape hatch), and covered observer-bin resolution plus envelope-to-state-dir landing with in-process tests.
## Evidence
