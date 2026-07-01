## Overview

The `/plan:close` Stop-guard (`plugins/plan/plugin/hooks/stop-guard.ts`) fires a
corrective "mid-saga" block whenever a close session ends its turn without having
run `close-finalize`. But the close saga legitimately ends its turn to await an
async subagent it just spawned (the quality-auditor, then the close-planner) — the
harness re-invokes the session on the child's completion notification. That
await-stop trips a FALSE-POSITIVE block, and the closer then wastes a full turn
investigating whether it erred. This epic makes the close branch authoritative: it
reads the Stop payload's `background_tasks` (already parsed) and allows the stop
when an in-flight subagent is present, while preserving the guard's genuine catch —
a closer that stopped after its agents returned but before finalizing.

## Quick commands

- `cd plugins/plan && bun test test/stop-guard.test.ts` — the guard's conformance suite (in-process, zero real git).
- `cd plugins/plan && bun run lint && bun run typecheck` — biome + tsc over the hook dispatchers.

## Acceptance

- [ ] An in-flight-subagent close Stop is allowed (zero subprocess); a post-return shell-only close Stop still blocks.
- [ ] The gate keys on `type:"subagent"` + `status:"running"` presence, is non-throwing/fail-open, and adds no subprocess to the close branch.
- [ ] The block message and the "message-only" comments + README are corrected to the two-gate reality.
- [ ] `bun test` + lint + typecheck green.

## Early proof point

Task that proves the approach: `.1`. If it fails (the gate can't cleanly preserve
the post-return block): fall back to gating on `status !== "completed"`, or split the
docs into a follow-up — but the natural experiment on the real closer session
already confirms the running-subagent-vs-shell-only split, so failure is unlikely.

## References

- Root cause + fix confirmed against the real closer session's raw Stop payloads: the auditor-await and planner-await stops carried the running `plan:quality-auditor` / `plan:close-planner` subagent entry; the post-return stops carried only the shell `keeper bus watch` entry (so the array is never empty — the gate must key on subagent presence, not length).
- `background_tasks` is a documented Claude Code Stop-hook input field (introduced v2.1.145, 2026-05-19; local claude 2.1.197): entries carry `id`/`type`/`status`/`description`, plus `agent_type` on subagents. Official purpose: distinguish "session done" from "session paused waiting for background work". Docs: code.claude.com/docs/en/hooks.
- Shape-coercion template: `src/derivers.ts:266 extractBackgroundTasks` — mirror the defensive style, do NOT import (dep-free hook); note the top-level-vs-`data.` access and subagent-vs-shell discriminant inversions.

## Docs gaps

- **plugins/plan/plugin/hooks/stop-guard.ts** (comments): prune the "message-only" assertions (header, `CLOSE_ALLOW_PATTERNS` JSDoc, the inline "Only a bare mid-saga stop blocks", and the `closeBlockReason` JSDoc) to present-tense covering both allow gates.
- **plugins/plan/README.md** (~:169-172): the "Stop checklist guard" line implies every mid-saga stop blocks and that the guard verifies live state via a `keeper plan` call before blocking — correct both for the two-gate, zero-subprocess close branch.
