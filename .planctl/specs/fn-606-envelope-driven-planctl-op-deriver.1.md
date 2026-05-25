## Description

**Size:** M
**Files:** src/derivers.ts, src/plan-classifier.ts, plugin/hooks/events-writer.ts, src/reducer.ts (comment-only), test/derivers.test.ts, test/events-writer.test.ts, test/reducer.test.ts, test/plan-classifier.test.ts, CLAUDE.md, README.md

### Approach

Rewrite `extractPlanctlInvocation` in src/derivers.ts (line 417) to gate on `hookEvent === "PostToolUse" && toolName === "Bash"` (exact-match, NOT a `startsWith` — `PostToolUseFailure` has no `tool_response` and must not be matched). Read `data.tool_response.stdout`. Defensive shape probes (mirror `extractSubagentAgentId` at plugin/hooks/events-writer.ts:93-109): type-check, length-cap at 64000 chars, `startsWith('{')` hint check, try-catch around `JSON.parse`. Extract the top-level `planctl_invocation` key as the sentinel — null/absent sentinel returns null. From the envelope, read `op` (string), `target` (string|null), `subject` (string|null). Derive `epic_id`/`task_id` via existing `parsePlanRef(target)` — no change. Set `subject_present = subject != null`. Return the same `PlanctlInvocation` shape as today.

Delete `PLANCTL_COMMAND_RE` (src/derivers.ts:331-332) and `PLANCTL_READONLY_VERBS` (src/derivers.ts:358-369) entirely — envelope-presence is the mutation sentinel; the allowlist's "every new verb requires a code change" maintenance tax vanishes.

In src/plan-classifier.ts:289-294, extend the creator predicate from `entry.op === "create"` to `entry.op === "create" || entry.op === "scaffold"`. Per-window suppression and refiner-then-creator semantics unchanged. `normalizePlanctlOp` stays as-is (strips `epic-`/`task-` prefixes; `scaffold` and `close` are already bare). Document the deliberate TS-only divergence from the Python reference in `normalizePlanctlOp`'s docstring — the Python `apps/cli_common/cli_common/planctl_invocations.py` does NOT recognize `scaffold` as a creator; keeper's classifier is strictly richer.

In plugin/hooks/events-writer.ts (lines 337-356), flip the gating event for the `extractPlanctlInvocation` call site from PreToolUse:Bash to PostToolUse:Bash. Update the inline comment block (lines 337-343) — strip the regex-parse framing, name envelope parsing. The existing five-column INSERT (named bindings) is unchanged.

In src/reducer.ts: the trigger gate at line 1941 (`event.planctl_op != null || …`) is hook-event-agnostic and requires NO CODE CHANGE — once the deriver stamps PostToolUse:Bash rows instead of PreToolUse:Bash rows, the existing `planctl_op != null` arm fires correctly on the new source event. Update only the surrounding comment that names PreToolUse:Bash.

Update CLAUDE.md line 65 (Event-sourcing invariants — derivers paragraph): name PostToolUse:Bash as `extractPlanctlInvocation`'s source event; delete the `PLANCTL_READONLY_VERBS` reference. Update README.md (lines 32-35 + line 379): rewrite the planctl_op derivation prose for PostToolUse + envelope; extend the creator definition to include `scaffold`.

### Investigation targets

**Required** (read before coding):
- `plugin/hooks/events-writer.ts:93-109` — `extractSubagentAgentId` is the canonical hook-side precedent for reading `data.tool_response`; mirror its defensive-probe shape EXACTLY.
- `src/derivers.ts:417-458` — `extractPlanctlInvocation` (rewrite target)
- `src/derivers.ts:287-302` — `parsePlanRef` (reuse on `envelope.target`; do not re-implement)
- `src/plan-classifier.ts:286-302` — creator predicate (extension point)
- `src/reducer.ts:1941-1946` — fan-out gate; confirm no code change beyond comment
- `test/derivers.test.ts:168-470` — existing `pre(command)` helper at lines 168-170 is the template for a parallel `post(envelope)` helper

**Optional** (reference as needed):
- `test/events-writer.test.ts:759-923` — inversion sites; line 874 in particular currently asserts the OPPOSITE of correct behavior post-change
- `test/reducer.test.ts:2862-2882` — `planctlEvent` helper; flip `hook_event: "PreToolUse"` → `"PostToolUse"` (single-line change)
- `.planctl/specs/fn-598-creator-refiner-from-planctl-invocations.6.md` — original-design rationale for the (now-being-replaced) input-command-regex approach
- `scripts/board.ts` header doc (lines 144-146, 467) — no hook-event naming; low impact

### Risks

- Test fixture inversions are subtle: test/events-writer.test.ts line 874 (and test/derivers.test.ts line 172) currently assert that PostToolUse:Bash leaves the columns NULL — these flip entirely, not just rename. Easy to miss on a casual review.
- Hook performance: JSON.parse runs on every PostToolUse:Bash event (most are NOT planctl). The `startsWith('{')` pre-parse hint reduces this to a single-byte check on the common non-JSON case; the length cap (64000 chars) protects against pathological inputs. Cold-start budget unchanged.
- Envelope-less mutations from older planctl versions silently drop edges. Acceptable — planctl is internally controlled.
- Widening: the new gate accepts ANY Bash command whose stdout carries the `planctl_invocation` sentinel — `bash -c '…'`, `/abs/path/planctl`, env-var-prefixed invocations all now stamp (the old regex rejected these). This is intended (envelope is authoritative) but should be mentioned in the deriver docstring.

### Test notes

- Add a `post(envelope)` helper in test/derivers.test.ts mirroring the existing `pre(command)` helper. Cover: scaffold (sentinel + epic-ref target), epic-close (sentinel + epic-ref target), task-set-tier (sentinel + task-ref target), non-PostToolUse → null, non-Bash → null, non-string stdout → null, malformed JSON → null, JSON without `planctl_invocation` key → null, length cap exceeded → null, `PostToolUseFailure` (if test infra can simulate) → null.
- In test/events-writer.test.ts: rename PreToolUse → PostToolUse in test names; INVERT line 874's assertion (PostToolUse:Bash with envelope now populates the columns); add a fresh test asserting PreToolUse:Bash with a planctl command leaves the columns NULL (negative case for the new gate).
- In test/reducer.test.ts: flip `planctlEvent`'s `hook_event` to `"PostToolUse"` (one line). Downstream fan-out tests should pass with no further changes — they assert column behavior, not source-event shape. Verify test/reducer.test.ts:3159 (re-fold determinism) still green.
- In test/plan-classifier.test.ts: add a unit test asserting `entry.op === "scaffold"` with an epic-shaped target produces a creator edge; per-window suppression still holds when both `create` and `scaffold` fire in the same window.

## Acceptance

- [ ] `extractPlanctlInvocation` gates on `hookEvent === "PostToolUse" && toolName === "Bash"` exact-match
- [ ] Deriver parses `data.tool_response.stdout` and extracts the top-level `planctl_invocation` envelope; defensive on missing sentinel, malformed JSON, oversize stdout
- [ ] `PLANCTL_COMMAND_RE` and `PLANCTL_READONLY_VERBS` deleted from src/derivers.ts
- [ ] Classifier creator predicate accepts `op === "scaffold"` alongside `op === "create"`
- [ ] `normalizePlanctlOp` docstring documents the deliberate TS-only divergence from `apps/cli_common/cli_common/planctl_invocations.py`
- [ ] Hook gates `extractPlanctlInvocation` on PostToolUse:Bash; PreToolUse:Bash no longer stamps the planctl_* columns
- [ ] src/reducer.ts trigger gate unchanged; surrounding comment updated to name PostToolUse:Bash
- [ ] test/derivers.test.ts has a `post()` helper; PreToolUse-gate tests invert to PostToolUse-gate; new scaffold + epic-close + task-set-tier envelope cases pass
- [ ] test/events-writer.test.ts line 874 assertion is inverted; new PreToolUse-no-stamp negative test passes
- [ ] test/reducer.test.ts `planctlEvent` helper stamps `hook_event: "PostToolUse"`; existing fan-out tests pass without further change; line 3159 re-fold determinism stays green
- [ ] test/plan-classifier.test.ts has a scaffold → creator predicate test
- [ ] CLAUDE.md line 65 and README.md lines 32-35 + 379 updated; `bun test` is green

## Done summary

## Evidence
