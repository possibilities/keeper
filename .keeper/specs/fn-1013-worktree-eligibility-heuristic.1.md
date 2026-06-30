## Description

**Size:** M
**Files:** src/worktree-eligibility.ts (new), test/worktree-eligibility.test.ts (new)

### Approach

A new dep-light, PRODUCER-ONLY module mirroring `src/git-toplevel.ts` (node:fs/node:path only, a read-cap const, fail-safe default). Three exports:

- **PURE** `classifyWorktreeEligibility(signals: RepoSignals): { eligible: boolean; reason: string }` — a total function over already-gathered signals (per-manifest-present booleans, per-workspace-marker booleans, `hasSubmodules`, `probeError`). No I/O. `eligible` iff (>=1 language manifest) AND (no workspace marker) AND (no submodules) AND (no probeError); else `disabled` with a specific reason: `worktree-disabled:no-manifest` | `:workspace-marker:<which>` | `:submodules` | `:probe-error`.
- **PRODUCER** `assessRepo(toplevel: string): { eligible, reason }` — gathers `RepoSignals` via fs (existence-check before read; <=32KB read cap), then calls the pure fn. Fails CLOSED: any EACCES/IO/parse failure on an EXISTING file sets `probeError` -> disabled; a missing file (ENOENT) is "absent", NOT an error.
- **`memoizedAssessRepo()`** factory returning a per-cycle cache closure keyed by toplevel — copy `memoizedNullableGitToplevel`'s shape (undefined-miss sentinel, GC'd per cycle so a transient failure re-probes next cycle).

Marker detection (per practice-scout):
- Language manifests (existence): package.json; pyproject.toml/requirements.txt/setup.py/setup.cfg/Pipfile; Cargo.toml; go.mod; build.zig; deno.json[c]; Gemfile; composer.json; Package.swift. `package.json` alone is sufficient — a lockfile only refines the PM label, not eligibility.
- Workspace markers, existence-only: pnpm-workspace.yaml, turbo.json, nx.json, lerna.json, rush.json, go.work.
- Workspace content markers (read <=32KB, comments stripped): root package.json `"workspaces"` KEY present (`JSON.parse`, `"workspaces" in obj` — even `[]` or `{packages:[]}`); Cargo.toml `^\s*\[workspace\]` (disables ALWAYS, even with `[package]`); pyproject.toml `^\s*\[tool\.uv\.workspace\]`. NO new TOML/JSON parser dependency — line-anchored regex (mirror `codex-trust.ts`); a multiline-string false positive errs toward disable (the SAFE direction); an unparseable/ambiguous EXISTING manifest -> `probeError` -> disabled.
- Submodules: `.gitmodules` existence.

### Investigation targets

**Required** (read before coding):
- src/git-toplevel.ts:91-118 — `memoizedNullableGitToplevel` closure shape to mirror
- src/git-toplevel.ts:18-30 — `gitResolveEnv` (only if shelling git; the manifest peek is pure fs)
- src/codex-trust.ts — the existing hand-rolled, no-parser-dep TOML precedent

**Optional:**
- src/worktree-plan.ts:165 — `worktreePathFor`, for producer-module path conventions

### Risks

- TOML string-match footguns (multiline strings, dotted/quoted headers `["workspace"]`, same-line comments) — anchor on a line boundary, strip comments, fail closed on ambiguity.
- An over-broad error definition disables every repo — ENOENT MUST be "absent", not an error.

### Test notes

Exhaustively unit-test the PURE `classifyWorktreeEligibility` with synthetic `RepoSignals` (clean single, crisp polyglot, each workspace-marker kind, no-manifest, submodules, probeError). Cover `assessRepo`'s fs-gather + fail-closed + ENOENT-vs-error with a small per-test tmpdir fixture (fs is allowed in the fast tier; no git/daemon/subprocess). Oracle: the marker set reproduces keeper=eligible, arthack=disabled(workspace), zellijsub=disabled(cargo-workspace), a bare docs dir=disabled(no-manifest).

## Acceptance

- [ ] `classifyWorktreeEligibility` is pure (no I/O imports) and total over `RepoSignals` including an explicit `probeError` arm
- [ ] eligible iff (>=1 language manifest) AND (no workspace marker) AND (no submodules) AND (no probeError); the reason string names the disabling signal
- [ ] Cargo.toml with both `[package]` and `[workspace]` -> disabled; `package.json` `"workspaces":[]` -> disabled; `[tool.poetry]` alone -> NOT a workspace
- [ ] `assessRepo` fails closed (disabled) on EACCES/parse error of an existing file; ENOENT is treated as absent
- [ ] reads are existence-checked first and capped (<=32KB); NO new third-party dependency added
- [ ] `memoizedAssessRepo` caches per toplevel with an undefined-miss sentinel
- [ ] unit tests reproduce the approved oracle: keeper=eligible, arthack=disabled(workspace), zellijsub=disabled(cargo-workspace), no-manifest dir=disabled
- [ ] the fast test tier adds no real git/daemon/subprocess

## Done summary

## Evidence
