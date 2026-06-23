## Description

**Size:** S
**Files:** cli/pair.ts, src/pair-command.ts, test/pair-command.test.ts, plugins/keeper/skills/pair/SKILL.md

### Approach

Add a fail-loud self-collision guard so a misfire never surfaces as success —
defense-in-depth behind the agentwrap fix (task .1). After the partner result
is resolved (transcriptPath known), if `basename(transcriptPath)` without the
`.jsonl` suffix equals the driver's `CLAUDE_CODE_SESSION_ID` (read from the
orchestrator env in cli/pair.ts), do NOT emit a `completed` result with a bogus
message — emit the two-line `failed` contract with
`error=self-transcript-collision` and write no message. Put the pure comparison
in src/pair-command.ts as a small exported predicate (unit-testable, leaf
discipline — no DB import), and wire it in cli/pair.ts at the output-assembly
site (around `:309-336`, where `buildPairOutput` is called). Keep keeper pair's
public two-line stdout and `--output` YAML shape unchanged EXCEPT this new
failure mode. Add `error=self-transcript-collision` to the SKILL.md
failure-mode list (forward-facing).

### Investigation targets

**Required** (read before coding):
- cli/pair.ts:250 — driver cwd; :309-336 — launch + output assembly (guard wires here)
- src/pair-command.ts:483-538 — `buildPairOutput`; :367-407 — `parseShowLastMessageJson` (transcriptPath source)

**Optional:**
- plugins/keeper/skills/pair/SKILL.md — failure-mode list
- test/pair-command.test.ts — pure-unit-test style (fast tier, no spawn/DB)

### Risks

- Read `CLAUDE_CODE_SESSION_ID` from the orchestrator env in the CLI layer; keep the predicate in src/pair-command.ts pure (string in, verdict out) so it stays fast-tier and leaf-clean.

### Test notes

Pure unit test in test/pair-command.test.ts (fast tier): collision case
(basename === CLAUDE_CODE_SESSION_ID → failure envelope, no message) + a
non-collision case (normal output preserved). `bun test && bun lint && bun typecheck`.

## Acceptance

- [ ] When the resolved transcript basename equals the driver's `CLAUDE_CODE_SESSION_ID`, keeper pair emits the `failed` contract with `error=self-transcript-collision` and no bogus message.
- [ ] Non-collision results are unchanged (public two-line stdout + `--output` YAML shape preserved).
- [ ] A pure unit test covers both cases in the fast tier.
- [ ] SKILL.md failure-mode list includes `self-transcript-collision`.
- [ ] `bun test`, `bun lint`, `bun typecheck` pass.

## Done summary
Added a fail-loud self-transcript-collision guard: isSelfTranscriptCollision (pure predicate in src/pair-command.ts) wired at the output-assembly site in cli/pair.ts so a resolver fallback matching the driver's own transcript emits failed (error=self-transcript-collision) instead of a bogus completed. Covered by fast-tier unit tests; SKILL.md failure-mode list updated.
## Evidence
