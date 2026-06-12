## Description

**Size:** S
**Files:** docs/exec-backend.md, README.md, CLAUDE.md, src/types.ts, src/daemon.ts, src/view-shell.ts, src/reducer.ts, src/dash/exit-triggers.ts, keeper/api.py, .promptctl/sketches/autopilot-zellij-clean-mint.yaml

### Approach

Rewrite `docs/exec-backend.md` against the post-teardown module — a full rewrite, not an append: the two-backend framing goes (tag-dispatch paragraph, `backendType` snippet, zellij fallthrough sentences, zellij launch/focusPane paragraphs, the whole Zellij session-ensure block, the eight `buildZellij*` helper-table rows, the zellij qualifier on `execBackendEnvMeta`, the closing `DEFAULT_EXEC_BACKEND` paragraph). Keep the table-of-helpers + fenced-ts style. Keep the "Extending to a new backend" section only if the seam it describes survives task .1's collapse — read the final code first.

README.md, four clusters: hook env-scraping (~58-62, becomes tmux-only); `exec_backend` config key (~320-349 — default `tmux`, example YAML updated, the warn-and-fall-back sentence retargets tmux); architecture hook-scraping (~1742-1748); autopilot/ExecBackend block (~2252-2349, including the legacy-bucket note at ~2349). CLAUDE.md, two line edits: the hook-rules "Scraping is scoped" bullet drops `ZELLIJ*`; the test-isolation section drops the `includeZellij`/sixth-var sentence. CLAUDE.md is symlinked as AGENTS.md — edit in place, never rm+recreate.

Sweep the comment-only zellij mentions in files tasks .1/.2 didn't touch: `src/types.ts` (backend_type/coordinate field docs — describe tmux-only derivation, note historical rows may carry other recorded values), `src/daemon.ts:2767`, `src/view-shell.ts:108` (the on_force_close detach note), `src/reducer.ts:2927` (comment ONLY — zero fold-logic change), `src/dash/exit-triggers.ts:22`, `keeper/api.py:136`. Delete `.promptctl/sketches/autopilot-zellij-clean-mint.yaml` (stale design sketch, human-approved as low-stakes). Forward-facing prose everywhere: state the tmux-only system as it is — no "formerly zellij", no removal narration.

Close the epic-level grep gate: `grep -ri zellij --exclude-dir=.planctl --exclude-dir=node_modules --exclude-dir=.git .` returns zero hits.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts — the FINAL post-.1 shape; the doc rewrite must describe this, not the pre-teardown module
- docs/exec-backend.md — current structure and style to preserve
- README.md:58-62, 320-349, 1742-1748, 2252-2349 — the four clusters (line numbers approximate; re-locate by grep)

**Optional** (reference as needed):
- src/types.ts:219-236, 395-407 — backend coordinate field docs to retarget
- CLAUDE.md hook-rules + test-isolation sections

### Risks

- Line numbers in README will have drifted after .1/.2 — locate clusters by grep, not by the cited numbers.
- `test/reducer-projections.test.ts` and other fold tests may legitimately retain zellij string literals as historical event data (per .1) — if any remain, the epic grep gate needs those exact files excluded, or the literals replaced with a neutral token where the test only needs "some recorded string". Resolve with what .1 actually left behind; don't weaken fold tests to win a grep.

### Test notes

Prose-only change to src files (comments) — `bun test` fast tier plus a `bun run test:full` confirmation; no behavior assertions change. The real verification is the grep gate plus reading `docs/exec-backend.md` against the final module.

## Acceptance

- [ ] `docs/exec-backend.md` describes the tmux-only module accurately (helper table matches actual exports)
- [ ] README four clusters + CLAUDE.md two edits done; AGENTS.md symlink intact
- [ ] Comment-only files swept; `src/reducer.ts` diff is comment-only
- [ ] `.promptctl/sketches/autopilot-zellij-clean-mint.yaml` deleted
- [ ] Repo-wide zellij grep (excluding `.planctl/`) returns zero hits, or the spec documents the exact surviving fold-test literals and why
- [ ] `bun run test:full` green

## Done summary

## Evidence
