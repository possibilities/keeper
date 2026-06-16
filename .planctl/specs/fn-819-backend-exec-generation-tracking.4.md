## Description

**Size:** S
**Files:** README.md, cli/setup-tmux.ts, scripts/restore-agents.ts

Update the system map + CLI help to the generation-boundary model. Forward-facing prose only.

### Approach

Revise the README crash-restore-set subsection (~2369-2391): the "boundary-free: no global crash marker" claim is now FALSE — describe the kill-anchored generation window. Add `BackendExecStart` to the ninth-worker event-log contributions (~2400-2431, currently lists only WindowIndexSnapshot + TmuxPaneSnapshot). Add the restore offer to the setup-tmux README block (~1172-1190) + its HELP (cli/setup-tmux.ts:27-55). Add `--last-generation` to the restore-agents README block (~2393-2398) + its HELP (scripts/restore-agents.ts:74-110). No schema-history entry (no schema bump). CLAUDE.md needs no change (worker→main route + pidfd carve-out already covered).

### Investigation targets

**Required** (read before coding):
- README.md ~2369-2391 (crash-restore-set), ~2400-2431 (ninth-worker), ~1172-1190 (setup-tmux), ~2393-2398 (restore-agents)
- cli/setup-tmux.ts:27-55 (HELP), scripts/restore-agents.ts:74-110 (HELP)

### Test notes

Docs-only; verify line ranges against the live files (README grows — use as search anchors).

## Acceptance

- [ ] README crash-restore-set "boundary-free" claim revised to the generation-boundary model; ninth-worker list adds BackendExecStart.
- [ ] setup-tmux + restore-agents README blocks and both HELP strings document the offer + `--last-generation`.
- [ ] No stale "boundary-free / no crash marker" wording remains.

## Done summary
Docs for the generation-boundary crash-restore model were already shipped in the implementation commits (96e7de44, 5870703c): README crash-restore-set subsection describes the kill-anchored generation window (no stale 'boundary-free' wording), ninth-worker list includes BackendExecStart, and both setup-tmux + restore-agents HELP/README blocks document the restore offer and --last-generation flag. Verified clean; no further changes needed.
## Evidence
