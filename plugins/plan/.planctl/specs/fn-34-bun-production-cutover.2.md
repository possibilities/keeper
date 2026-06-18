## Description

**Size:** M
**Files:** scripts/promote.sh (new), package.json, docs/runbook content folded into README or CLAUDE.md per the docs task split, ~/.local/bin/planctl (machine state)

### Approach

The swap. promote.sh (wired as `bun run promote`): hard-fail unless `bun run build` succeeds in the same invocation; copy dist/planctl-bun to ~/.local/bin/.planctl.tmp (creating ~/.local/bin if absent; the temp lives in the DESTINATION dir so the rename is same-filesystem atomic); `mv -f` over ~/.local/bin/planctl — the current path entry is a SYMLINK into the uv tool dir and the mv replaces the symlink itself (never resolve/follow it; never cp over the live file); chmod +x; echo the promoted `git rev-parse HEAD`; abort non-zero at any step leaving the old binary intact. Pre-swap: rehearse the rollback (`uv tool install --force /Users/mike/code/planctl`, verify the shim answers, confirm `command -v planctl` still resolves to ~/.local/bin with no earlier-PATH shadow) — abort the cutover if the rehearsal fails. Execute the promote. Soak: scratch project in its own fresh git repo; run the full cycle (init → scaffold → claim → done → close-preflight → audit submit → verdict submit → close-finalize) against the swapped binary; then the first-hour posture per the runbook — triggers are: any non-zero exit on a known-good verb, any Uncaught/error: stderr from planctl, p95 invocation time > 2x the rehearsal baseline (measure a 20-invocation baseline of `planctl status` pre-swap for the comparison); on trigger, run the verbatim rollback and surface loudly. Write the runbook section: promote command, rollback command, triggers, the hash -r/rehash note, and the rollback-window statement (rollback validity ends when the Python package leaves the repo).

### Investigation targets

**Required** (read before coding):
- package.json scripts block — wiring the promote script
- The current ~/.local/bin/planctl symlink — confirm target shape before writing the mv logic
- tests/conftest.py conformance env — nothing in the harness assumes the shim (PLANCTL_BIN is explicit)

### Risks

This task mutates machine state — every abort path must leave the old binary live; the rehearsal must come first; the soak's scratch project must be isolated so auto-commit failures don't confound the signal.

### Test notes

Post-promote: `command -v planctl` resolves to the regular-file bun binary; the full soak cycle green; both conformance directions still green (PLANCTL_BIN at the promoted binary; Python fast gate untouched).

## Acceptance

- [ ] Promote script atomic, build-gated, symlink-aware, abort-safe; rollback rehearsed BEFORE the swap and documented verbatim
- [ ] Swap live: planctl on PATH is the bun binary; soak cycle + first-hour posture clean per thresholds
- [ ] Runbook content landed (triggers, rollback, shell-cache note, rollback window)

## Done summary
Promote script (bun run promote) swaps ~/.local/bin/planctl to the compiled bun binary: build-gated, copy-to-temp-in-dest + atomic mv over the symlink path entry, abort-safe. Rollback rehearsed before the swap; full soak cycle green against the swapped binary; runbook landed in CLAUDE.md.
## Evidence
