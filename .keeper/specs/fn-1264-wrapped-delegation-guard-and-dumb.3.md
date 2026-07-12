## Description

**Size:** M
**Files:** plugins/plan/template/_partials/worker-implement-wrapped.md, plugins/plan/skills/work/SKILL.md, plugins/prompt/test/parity.test.ts

Rewrite the wrapped worker contract so the wrapper never edits source — aligning the prose
with what the guard (task 2) permits, so the two co-define one surface and never deadlock.
The wrapper becomes a dumb courier: resolve the serving provider, launch the leg, wait in
chunks, and on an unfinished/failed leg return a typed status to the parent `/plan:work`;
the parent drives iteration by resuming the leg via `keeper agent run --resume <leg>` with
instructions (implementation fixes, test failures, AND lint failures all go back to the leg).
The wrapper owns ONLY the keeper close-out: stage the leg's git-derived change set, land ONE
`keeper commit-work` commit carrying the wrapper's own `Task`/`Job-Id` trailer, then
`keeper plan done`. Remove every instruction that has the wrapper edit, hand-fix, or normalize
file CONTENT — including the current `commit-work` lint-fix recovery (re-delegate instead).

### Approach

Switch the leg's `--output` target from the free-choice placeholder to the injected
`$KEEPER_WRAPPED_ENVELOPE` (a literal shell env reference so it resolves to exactly the path
the producer set — path A/path-B divergence would break task 4's detection). Preserve the
one-session tmux shape verbatim: `--session wrapped --name wrapped::<task-id>`. Keep the leg
launch consistent with task 2's resolved leg-launch mechanism (native detach preferred over
the `sh -c nohup` shell wrapper). Update `plugins/plan/skills/work/SKILL.md` only where the
parent's resume/iteration contract changes (the parent now resumes the LEG through the wrapper,
or re-messages the wrapper to resume). Re-render every wrapped worker cell via
`keeper prompt render-plugin-templates` and re-record the parity oracle
(`bun run capture-oracle`); regenerate the `.managed-file-dont-edit` sha256 sidecars.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- plugins/plan/template/_partials/worker-implement-wrapped.md — the current wrapped Phase 2-6 body (contract Write, leg launch, adjudicate, normalize/commit).
- plugins/plan/template/agents/worker.md.tmpl:5,117 — the `current_driver == "wrapped"` frontmatter + partial-include branch.
- src/agent/main.ts:1200-1229 — `--output` writes the result envelope atomically on every outcome (the leg-done signal the wrapper waits on).
- plugins/prompt/test/parity.test.ts + plugins/prompt/test/oracle/fixtures/ — the rendered-template goldens and the re-capture path.

**Optional:**
- plugins/plan/skills/work/SKILL.md — the parent orchestration + resume machinery to align.

### Risks

- Only wrapped-cell renders include this partial, so only wrapped goldens change — but the ce88b254 one-session shape must survive byte-for-byte; re-capture is mandatory or parity fails.
- The keeper close-out MUST stay wrapper-owned (the codex leg cannot mint the claude `Job-Id` trailer keeper's projections discharge on). Do not move commit/done into the leg.
- Keep the wrapper contract and the guard allowlist in lockstep — any wrapper step the guard denies deadlocks every wrapped task.

### Test notes

Parity/render: re-run `bun scripts/vendor-corpus.ts --check` and `bun test plugins/prompt/test/parity.test.ts`
green after re-capture. Confirm a rendered wrapped worker cell contains the `$KEEPER_WRAPPED_ENVELOPE`
`--output` reference and the `--session wrapped --name wrapped::<task-id>` shape.

## Acceptance

- [ ] The wrapped worker contract instructs the wrapper to never edit or hand-fix source; implementation, test, and lint iteration are delegated to the leg via harness resume, and only the keeper close-out (commit-work + plan done) is wrapper-owned.
- [ ] The leg's `--output` targets the injected `$KEEPER_WRAPPED_ENVELOPE`, and the one-session `--session wrapped --name wrapped::<task-id>` shape is preserved.
- [ ] Every wrapped worker cell is re-rendered and the parity oracle re-captured; `bun scripts/vendor-corpus.ts --check` and the parity suite are green.
- [ ] The parent `/plan:work` resume/iteration contract is consistent with the courier wrapper (no wrapper-side content edits assumed).

## Done summary

## Evidence
