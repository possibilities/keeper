## Description

**Size:** M
**Files:** system/shared/AGENTS.md, system/claude/.claude/CLAUDE.md, system/claude/.claude/AGENTS.md, src/agent/state-sharing.ts, src/agent/main.ts, src/codex-trust.ts, test/agent-state-sharing.test.ts, test/agent-pi.test.ts, test/helpers/agent-main-harness.ts

### Approach

Create `system/shared/AGENTS.md` as the one real source file — copy the 256-byte preamble currently in `system/claude/.claude/CLAUDE.md` verbatim. Add `defaultSharedStowDir()` mirroring `defaultClaudeStowDir()` (`import.meta.url` + `realpathSync` of `system/shared`). Generalize the claude-only `CANONICAL_STOW_LEAVES` into a per-harness leaf table where each leaf carries its own `{source, linkPath, compare, onDivergence}`: the claude `CLAUDE.md` leaf, the codex `AGENTS.md` leaf, and the pi canonical `AGENTS.md` leaf all SOURCE from `defaultSharedStowDir()/AGENTS.md` (the one real file); the claude `settings.json` leaf keeps sourcing the claude stow dir with `jsonSemanticEqual` + hard-error (do not regress it). Repoint `system/claude/.claude/CLAUDE.md` to a relative symlink `../../shared/AGENTS.md` (keeps the claude package self-consistent; the guard sources from shared directly so there is no realpath churn). Keep the `system/claude/.claude/AGENTS.md -> CLAUDE.md` sibling (repo pairing convention).

`onDivergence` is per-leaf. The claude leaves HARD-ERROR (throw `StateError`, exactly as today). The codex/pi leaves WARN-AND-RESPECT: a divergent REGULAR file is left in place and an `actionLog` WARNING is pushed via a NON-throwing sibling of `divergentClobberMessage` — NEVER a thrown `StateError` (main.ts catches `StateError` -> `exit(1)`, so a throw would abort a benign launch). A wrong-TARGET symlink is repaired to the shared source for ALL harnesses — that repair IS the codex cutover mechanism.

Codex-home: export the existing `resolveCodexHome` from `src/codex-trust.ts` (dep-light, `node:*` only — importing it from `src/agent/` is acyclic) and use it for the codex leaf's `linkPath = resolveCodexHome(env)/AGENTS.md`. Do NOT set/force `CODEX_HOME`; do NOT import `resolveCodexHomeDir` from `daemon.ts` (that edge cycles — daemon already imports from `src/agent/`); do NOT add a new copy of the resolver.

pi list: add `"AGENTS.md"` to `DEFAULT_PI_SHARED_PATHS` (NOT to `PI_PRESERVING_SHARED_PATHS`) and REMOVE `"SYSTEM.md"` (keep `APPEND_SYSTEM.md`). Materialize the canonical `~/.pi/agent/AGENTS.md` symlink in `ensurePiCanonicalRoot` BEFORE the profile loop runs, or the `:564` skip guard drops `AGENTS.md` for every profile.

main.ts wiring: add an `agent === "codex"` leaf-guard invocation, and make the shared-leaf assertion run REGARDLESS of `shouldPassthrough` — codex is almost always passthrough and claude's guard already runs unconditionally, so match that or the goal "reach ALL launches" fails for codex. Wire an injected `ensureCodexStateSharingFn` mirroring the claude/pi dep shape (deps type at :196-215, wiring at :306-315, plus a stub in `test/helpers/agent-main-harness.ts`). Keep the heavy pi profile farm `!shouldPassthrough`-gated, but assert the canonical pi `AGENTS.md` leaf unconditionally so passthrough default-account pi launches are covered too. Reuse `relinkCanonical` / `forcePathSymlink` (relative link targets); do not open-code `symlinkSync` or introduce a temp+rename idiom in this pass.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/state-sharing.ts:619-623 — `CANONICAL_STOW_LEAVES` (claude-only; generalize into the per-harness table)
- src/agent/state-sharing.ts:707-770 — `ensureCanonicalStowLinks` guard (the template; the onDivergence split slots in near :760)
- src/agent/state-sharing.ts:661-687 — `divergentClobberMessage` (needs a non-throwing sibling for codex/pi)
- src/agent/state-sharing.ts:94-110 — `DEFAULT_PI_SHARED_PATHS` (add AGENTS.md, drop SYSTEM.md at :105); :125-135 `PI_PRESERVING_SHARED_PATHS` (do NOT add AGENTS.md)
- src/agent/state-sharing.ts:552-555 — `ensurePiCanonicalRoot` (materialize canonical AGENTS.md HERE, before the profile loop)
- src/agent/state-sharing.ts:557-580 — `ensurePiProfileSharedLinks`; the `:564-567` skip guard is the ordering trap
- src/agent/state-sharing.ts:44-55 — `defaultClaudeStowDir` (mirror it for `defaultSharedStowDir`)
- src/agent/state-sharing.ts:777-787 — `relinkCanonical` / `forcePathSymlink` (reuse; relative targets)
- src/agent/main.ts:2135 — codex profile-exclusion; :2156-2180 dispatch (add codex branch; un-gate the leaf from passthrough); :2162 & :2174 `StateError`->`exit(1)` catch
- src/agent/main.ts:196-215, 306-315 — injected `*StateSharingFn` deps (add the codex one)
- src/codex-trust.ts:85 — `resolveCodexHome` (currently un-exported; export it; confirm acyclic)
- test/agent-state-sharing.test.ts — guard test template (mkdtemp HOME + injected env 4th arg); test/helpers/agent-main-harness.ts:223,228 — dep stubs

**Optional** (reference only):
- src/daemon.ts:5429-5432 — `resolveCodexHomeDir` (the pattern; do NOT import it into src/agent — cycle)
- test/agent-byte-pin.test.ts, test/agent-run-capture-golden.test.ts — golden pins likely to shift

### Risks

- Realpath churn if a leaf sources a symlink — source the claude/codex/pi doc leaves from the REAL `system/shared/AGENTS.md`; verify `readlink` stability across two consecutive launches.
- Byte/golden pins shift when the codex branch + new actionLog lines land — regenerate and review, don't let it surprise-fail the suite.
- Warn-and-respect that throws `StateError` would exit(1) on a benign human-edited codex/pi file — the sibling divergence path must be log-only.

### Test notes

Parallelize the existing per-leaf guard tests (creates-when-absent / no-op-when-correct / repairs-wrong-target / relinks-identical-clobber) across claude/codex/pi. NEW test: a divergent regular file at a codex/pi leaf -> no throw, live file untouched, WARNING pushed; the claude leaf still throws on divergence. Mirror the `defaultClaudeStowDir` describe for `defaultSharedStowDir` (asserts the shared file resolves). pi: canonical AGENTS.md materialized before profile links; named-profile AGENTS.md present (not skipped). Assert the codex leaf-guard fn is invoked on a passthrough-shaped codex launch. Fast tier only: mkdtemp HOME + injected env, no real daemon/git/subprocess. Regenerate the golden pins.

## Acceptance

- [ ] `system/shared/AGENTS.md` exists as a real file, and the generalized leaf table sources the claude/codex/pi doc leaves from it.
- [ ] A test proves each harness leaf, when the guard runs against a sandboxed HOME, is a symlink resolving to the shared source — including codex on a passthrough-shaped invocation.
- [ ] A test proves pi's canonical AGENTS.md is materialized before profile links and named-profile AGENTS.md links are present.
- [ ] A test proves a divergent regular file at a codex/pi leaf is left untouched, logs a WARNING, and throws no `StateError`; the claude leaf still throws on divergence.
- [ ] `DEFAULT_PI_SHARED_PATHS` contains `AGENTS.md` and not `SYSTEM.md`; `APPEND_SYSTEM.md` retained.
- [ ] `resolveCodexHome` is consumed from `codex-trust.ts` (no new copy, no daemon import), and keeper never sets `CODEX_HOME`.
- [ ] `bun test` is green including the new guard/pi coverage and regenerated golden pins.

## Done summary
Added system/shared/AGENTS.md as the one keeper-owned global-instruction source and generalized the launch-time canonical-stow guard into a per-harness leaf table (source/linkPath/compare/onDivergence): claude CLAUDE.md, codex AGENTS.md, and pi's canonical AGENTS.md all re-link to it, with claude hard-erroring and codex/pi warn-and-respecting a divergent human-edited file. Codex leaf-guard runs unconditionally; pi canonical AGENTS.md materializes before the profile loop (SYSTEM.md dropped, APPEND_SYSTEM.md kept).
## Evidence
