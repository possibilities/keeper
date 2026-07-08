## Description

**Size:** M
**Files:** src/agent/transcript-watch.ts, src/agent/run-capture.ts, test/agent-transcript-background.test.ts

### Approach

Behavioral contract: for claude transcripts, the wait stack accepts a stop
marker as terminal only when the session shows no live background agents at
that point — a settled stop (CONTEXT.md). Replace the claude arm's
first-stop-wins logic in the transcript stop scan with a line-order stateful
scan (line order is authoritative; timestamps are non-monotonic in real
transcripts): maintain a pending set that adds an agentId whenever a user
tool_result line carries a top-level toolUseResult OBJECT with status
"async_launched" (a failed launch — string toolUseResult with an is_error
tool_result — never enters), and retires an id when any later line carries the
matching `<task-id>X</task-id>` with a terminal `<status>`
(completed|failed|killed) — queue-operation lines of any operation AND injected
task-notification user lines both retire; retiring a non-member is a no-op so
descendant-agent and backgrounded-Bash notifications never gate. Track the
pending set across the whole file (a pre-startedAt launch still outstanding
blocks quiescence) while stop acceptance keeps the existing started-at filter.
Corroborating signal: a stop is not accepted while its governing turn_duration
line (when present in the scanned file) carries a nonzero
pendingBackgroundAgentCount; the field is never REQUIRED — absence imposes no
constraint (fail-open). Prefer returning the text-bearing assistant stop as the
accepted stop so the blessed stop carries the consolidated answer text; note
turn_duration trails the assistant end_turn by a beat in file order, so consider
a one-poll-tick settle grace before finalizing acceptance of a stop that is the
file's final line. Everything fails open: a transcript with none of the new
markers must behave byte-identically to the current parser; malformed lines are
skipped, never thrown on; the existing stop-timeout ceiling still bounds every
wait (retryable timed-out, partial message). codex/pi/hermes stop arms stay
byte-identical. Capture coupling: in the run-capture clean-wait tail, for claude
only, prefer the gated wait stop's message when non-null over the fresh
whole-file last-message re-scan (which a later human-resume turn can displace);
keep the re-scan as the fallback for structural stops with null text; codex/pi/
hermes capture preference unchanged. Reuse the module's existing line/JSON
helpers and keep it dep-free (node:* only). Hot-path hygiene: substring
pre-filter (indexOf on the marker substrings) before JSON.parse of candidate
lines; treat parsed ids as data only — never interpolate into shell or paths.
Whole-file re-scan per poll tick is retained deliberately; incremental
byte-offset tailing is an explicit non-goal.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/transcript-watch.ts:335 — findTranscriptStop, the first-stop scan the stateful gate replaces (claude arm only)
- src/agent/transcript-watch.ts:370 — claudeStopFromObject, the three claude stop shapes
- src/agent/transcript-watch.ts:102 — waitForTranscriptStop poll loop (whole-file re-scan per tick)
- src/agent/run-capture.ts:489 — captureFromHandle clean-wait tail (message preference inversion, claude-guarded)
- test/agent-pair-subcommands.test.ts:79 — writeClaudeTranscript fixture pattern to extend for multi-line transcripts

**Optional** (reference as needed):
- ~/.claude/projects/-Users-mike-code-keeper/72ab7971-1410-478d-b697-b886cfe5baf6.jsonl — incident ground truth: async_launched tool_result (line 100), premature end_turn (167-168), turn_duration with pendingBackgroundAgentCount 8 (175), queue-operation retires, injected task-notification (233)
- src/agent/transcript-watch.ts:637 — readLines / parseJsonObject / objectValue / stringValue helpers to reuse
- docs/adr/0021-transcript-only-background-agent-gating.md — the decision record this implements

### Risks

- A task-id can notify more than once and a retired agent can be resumed; freeze-on-first-accepted-stop semantics plus the count corroboration bound this, and the final-message directive (sibling task) carries the residual.
- pendingBackgroundAgentCount counts the descendant tree (a superset of direct children), so count-gating can over-wait; the stop-timeout ceiling bounds it to a retryable timed-out.
- Marker shapes are undocumented CLI internals that drift across versions; parsers match on presence and degrade to current behavior on absence — the regression floor is the old first-stop behavior, never a hang.

### Test notes

Extend the pair-subcommands fixture pattern (writeFileSync JSONL under the
encoded-cwd projects dir, pollIntervalMs/stopTimeoutMs overrides, poll-dont-
sleep) in the new test file. Cases: (a) async_launched then end_turn with
pending nonempty — not accepted, bounded wait returns timed-out with the
partial; (b) retire via queue-operation only (mid-turn shape, no injected user
line) then later stop — accepted; (c) retire via injected task-notification
then post-notification stop — accepted, captured message is the later turn's
text; (d) failed launch never enters pending; (e) descendant/bash task-id
notifications with no matching launch are no-ops; (f) nonzero
pendingBackgroundAgentCount blocks acceptance, absent field imposes nothing;
(g) background-free transcript — identical stop/message/outcome to today
(regression pin); (h) capture prefers the gated stop's text for claude and
falls back to the re-scan on structural stops; codex/pi fixtures untouched and
green. Optional cheap insurance: mirror the run-capture depgraph import-scan
for transcript-watch (node:* only).

## Acceptance

- [ ] A claude transcript recording a background-agent launch with no matching task-notification never yields a completed wait; the wait ends only via the stop-timeout as a retryable timed-out outcome carrying the partial message.
- [ ] A claude transcript where every launched background agent retires (via queue-operation lines or an injected task-notification) and a later stop follows yields a completed wait whose captured message is that later turn's text.
- [ ] A claude transcript containing none of the background markers produces the same stop, message, and outcome as before the change, and codex/pi/hermes wait and capture behavior is unchanged with their existing tests green.
- [ ] Failed background launches, descendant-agent notifications, and backgrounded-Bash notifications have no effect on the wait decision.
- [ ] A stop governed by a turn-duration line carrying a nonzero pending-background count is not accepted while the count is nonzero; a transcript lacking the field entirely is unaffected by the count rule.
- [ ] The full fast suite (bun test) is green.

## Done summary

## Evidence
