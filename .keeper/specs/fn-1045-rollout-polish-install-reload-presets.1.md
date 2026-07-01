## Description

**Size:** S
**Files:** scripts/install.sh, src/agent/main.ts, src/agent/dispatch.ts

### Approach

Two independent small fixes from the presets/install rollout:

1. **install.sh reload gate.** The keeperd bootout/bootstrap reload is gated
   only on `cmp -s` of `arthack.keeperd.plist`, so a pure source change (new
   `src/*.ts`) leaves the running daemon on stale code — the buildbot
   `keeper-install` job `bun link`s new CLI code but never restarts keeperd
   (it only reloads on a plist change or a manual `launchctl kickstart -k`).
   Add a source-change trigger: reload keeperd when the daemon's source
   advanced since its last boot — e.g. fingerprint the repo HEAD sha
   (mirroring arthack install.sh's `fingerprint_check`/`fingerprint_save`) and
   reload when it changed, OR compare the running keeperd process start time to
   `git log -1 --format=%ct`. Keep the plist-change trigger too (reload on
   EITHER). Preserve idempotency (no needless bounce when nothing changed) and
   the modern `launchctl bootout`/`enable`/`bootstrap` surface. `shellcheck` clean.

2. **presets list display.** `keeper agent presets list` renders `Presets (…)`
   + `Panels (…)` but not the `<harness>_default` pointers. Surface
   `claude_default`/`codex_default`/`pi_default` in the output (a short block
   like the Panels section), reading them off the `PresetCatalog` (fn-1039 added
   the fields). Optionally note the pointer keys in the `KEEPER_AGENT_HELP`
   `--x-preset` block (hold the column-34 indent).

### Investigation targets

**Required** (read before coding):
- scripts/install.sh — the cmp-gated plist bootout/bootstrap reload block (emits "keeperd plist unchanged and loaded; no reload")
- src/agent/main.ts — the `presets list` handler emitting the `Presets (…)` / `Panels (…)` lines (~1000-1043); `PresetCatalog` now carries `claude_default`/`codex_default`/`pi_default`
- src/agent/dispatch.ts — `KEEPER_AGENT_HELP` (~110-167), the `--x-preset` block, for an optional pointer-key note

**Optional** (reference as needed):
- ~/code/arthack/scripts/install.sh — the `fingerprint_check`/`fingerprint_save` pattern to mirror for source-change detection

## Acceptance

- [ ] `scripts/install.sh` reloads keeperd on a source/code change since the daemon's last boot, not only on a plist change; still idempotent (no needless bounce)
- [ ] `keeper agent presets list` displays the three `<harness>_default` pointers
- [ ] `bun test` green; `shellcheck` clean on `scripts/install.sh`

## Done summary

## Evidence
