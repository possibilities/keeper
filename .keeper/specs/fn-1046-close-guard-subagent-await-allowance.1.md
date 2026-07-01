## Description

**Size:** S
**Files:** plugins/plan/plugin/hooks/stop-guard.ts, plugins/plan/test/stop-guard.test.ts, plugins/plan/README.md

### Approach

Make the close branch of the Stop-guard authoritative about a legitimately-parked
closer instead of purely message-driven. The Stop payload the hook already
JSON-parses carries a top-level `background_tasks` array (a documented Claude Code
Stop-hook field, present since v2.1.145); a backgrounded child appears as
`{id, type:"subagent", status:"running", agent_type:"plan:…"}`.

1. Widen the inline payload type literal with `background_tasks?: unknown` — read it
   at payload TOP-LEVEL, NOT under `data.` (the `data.`-prefixed access in
   `src/derivers.ts` is the event-envelope shape and would make the gate always-false).
2. Add an EXPORTED `closeChildInFlight(bg: unknown): boolean` helper local to
   `stop-guard.ts` (do NOT import `extractBackgroundTasks` — that pulls a `src` dep
   into a dep-free hook; mirror its defensive shape-coercion STYLE only):
   `Array.isArray(bg) && bg.some(t => t !== null && typeof t === "object" &&
   (t as Record<string, unknown>).type === "subagent" &&
   (t as Record<string, unknown>).status === "running")`. It MUST be non-throwing —
   a shape error degrades to `false` (fall-through), never an abort.
3. In the close branch, insert the `closeChildInFlight(payload.background_tasks)`
   allow BEFORE the existing `closeStopAllowed(...) → emitBlock(...)` fall-through:
   an in-flight subagent → `return` (allow, zero subprocess). A present array with no
   running subagent (e.g. only the shell `keeper bus watch` entry a bus-subscribed
   close session always carries) → fall through to the message allow-list, then block.
   An absent/non-array `background_tasks` → `closeChildInFlight` is false → same
   fall-through → block (de-fanged by the rewritten reason).
4. Gate on `type === "subagent"` PRESENCE with `status === "running"`, NOT
   array-non-empty (the shell bus-watch entry means the array is never empty) and NOT
   `agent_type` pinning (presence-only).
5. Rewrite `closeBlockReason(epicId)` so its text is safe for BOTH the genuine-drop
   case AND the spawn→stop race window (the block can still fire before the registry
   lists the child): keep the asserted substrings (`close-finalize <id> --project`,
   "Never write or commit"), and add language that names the await case and tells an
   awaiting closer to just end the turn (the completion notification resumes it) —
   explicitly do NOT poll the child transcript (TaskOutput/ToolSearch) or finalize early.
6. Prune the now-inaccurate comments to present-tense (docs-prune, no provenance): the
   header allow-set enumeration, the `CLOSE_ALLOW_PATTERNS` JSDoc (scope it back to the
   message-pattern set), the inline "Only a bare mid-saga stop blocks" assertion (cover
   both allow branches), and the `closeBlockReason` JSDoc. Keep the SKILL.md-citation
   comments intact.
7. Fix `plugins/plan/README.md` — the "Stop checklist guard" line (~:169) implies every
   such stop blocks; add one clause that the block fires only when neither the
   message-pattern gate nor the in-flight-subagent gate fires. Also correct the nearby
   "verifies live state with a read-only `keeper plan` call before blocking" sentence
   (~:172) so it isn't wrong for the zero-subprocess close branch.

### Investigation targets

**Required** (read before coding):
- plugins/plan/plugin/hooks/stop-guard.ts:120-127 — the close branch to make authoritative (insert the allow before closeStopAllowed→emitBlock).
- plugins/plan/plugin/hooks/stop-guard.ts:80-85 — inline payload type literal (add background_tasks?: unknown, top-level).
- plugins/plan/plugin/hooks/stop-guard.ts:36-48 — CLOSE_ALLOW_PATTERNS + closeStopAllowed (keep; the fall-through gate).
- plugins/plan/plugin/hooks/stop-guard.ts:64-74 — closeBlockReason (rewrite + JSDoc prune).
- src/derivers.ts:266-302 — extractBackgroundTasks: the defensive shape-coercion TEMPLATE to mirror (guard null/!object, !Array.isArray, per-entry continue, never throw). NOTE the inversion: it reads data.background_tasks and allowlists type==="shell"; the new helper reads TOP-LEVEL and keys on type==="subagent"+status==="running". Do NOT import it.
- plugins/plan/test/stop-guard.test.ts:281-296 — the close-branch subprocess ladder + the "close branch never calls reconcile / zero keeper subprocess" invariant (:294-295) to mirror for the new allow test.
- plugins/plan/test/stop-guard.test.ts:86-93 — the closeBlockReason substring assertions to update in lockstep.
- plugins/plan/test/stop-guard.test.ts:189-196 — stopPayload(extra) builder (pass background_tasks via extra) + writeCloseMarker.

**Optional** (reference as needed):
- test/derivers.test.ts:1388-1530 — the background_tasks shape-coercion coverage matrix to mirror for closeChildInFlight fixtures.
- plugins/plan/plugin/hooks/lib.ts — readStdin/emitBlock/Marker (imports only, no change).

### Risks

- `closeChildInFlight` MUST NOT throw: it runs inside `main()`, and a throw is swallowed by `main().catch(()=>{})`, which would abort before `emitBlock` and LOSE the genuine mid-saga block. Write it as defensively as `extractBackgroundTasks` (degrade to false, never throw) — stronger than top-level fail-open.
- Presence gate, not array-non-empty: the shell `keeper bus watch` entry means `background_tasks` is never empty for a bus-subscribed close session — a length check would allow forever and silently kill the genuine catch.
- Top-level vs `data.`-prefixed access: copying `extractBackgroundTasks`'s `data.background_tasks` narrowing would make the gate always-undefined/false and silently un-fix the bug.
- Spawn→registry race: a subagent may not be listed at the exact Stop instant, so one (de-fanged) block can still fire; `stop_hook_active` caps it at one and the rewritten reason keeps it safe. No code lever beyond the reason.

### Test notes

Extend both tiers of stop-guard.test.ts:
- Tier-1 (in-process, imported): table-driven `closeChildInFlight` cases — running subagent → true; `status:"completed"` / absent-status subagent → false; shell-bus-watch-only (non-empty, no subagent) → false; malformed/null entry → false (no throw); non-array/absent → false. Update the `closeBlockReason` assertion to pin the new await-case + no-poll wording alongside the kept substrings.
- Tier-2 (subprocess ladder): close marker + `background_tasks` with a running subagent → allow (assert `stdout===""` AND `planCliCalled===false` — zero subprocess, mirroring :294-295); close marker + shell-bus-only + bare message → block with the mid-saga reason; existing terminal-halt allow cases still pass.
- Run `bun test` (fully in-process) + `bun run lint` + `bun run typecheck` from plugins/plan/.

## Acceptance

- [ ] A close-session Stop whose `background_tasks` contains a `type:"subagent"` entry with `status:"running"` is ALLOWED (no block), with zero keeper subprocess spawned.
- [ ] A close-session Stop whose `background_tasks` holds only the shell `keeper bus watch` entry (no running subagent) with a bare last message still BLOCKS with the mid-saga reason — the genuine post-return catch is preserved.
- [ ] `closeChildInFlight` is exported, non-throwing on any malformed/absent `background_tasks` (degrades to false), and gates on `type==="subagent"` + `status==="running"` presence (not array-non-empty, not `agent_type`).
- [ ] `closeBlockReason` names the await case and tells an awaiting closer to end the turn without polling the child transcript or finalizing early, while keeping the `close-finalize <id> --project` + "Never write or commit" substrings; its test assertion is updated in lockstep.
- [ ] The "message-only" comment assertions in stop-guard.ts are pruned to present-tense covering both allow branches; plugins/plan/README.md's Stop-guard line reflects the two-gate logic and the zero-subprocess close branch.
- [ ] `bun test`, `bun run lint`, and `bun run typecheck` pass from plugins/plan/.

## Done summary

## Evidence
