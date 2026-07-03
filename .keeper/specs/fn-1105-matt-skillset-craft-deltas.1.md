## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

The merge-resolver worker brief gains one investigative step and one guard, both branches. Before classifying a conflict, the resolver must read the primary sources behind each side — commit messages of the conflicting commits, plus `keeper find-file-history` / `keeper search-history` for the why — so classification is grounded in each change's intent, not just the diff text. Add an explicit "do NOT invent new behaviour — resolve by composing the two intents verbatim or not at all" guard. Graft into the shared guardrail/blockedPath string arrays so the parse-miss branch and the full branch both inherit. The existing abort-on-not-mechanically-clear semantics, the "when UNSURE default to BLOCKED" line, and the no-pause discipline are load-bearing and must survive verbatim.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1098 is editing this region).*

**Required** (read before coding):
- src/daemon.ts:1282-1378 — buildResolverBrief: pure function, two branches, shared guardrail (:1291) and blockedPath (:1302) arrays
- test/daemon.test.ts — existing buildResolverBrief / parseMergeConflictReason assertions; wording changes break them

**Optional**:
- The CLAUDE.md Autopilot bullet — resolver-first sequencing landed by fn-1098; the brief's surrounding contract

### Risks

- fn-1098 landed changes to this region after planning; re-read the live function before editing rather than trusting the line refs.

### Test notes

Extend the existing daemon test assertions to pin the new archaeology step and guard line in BOTH branches.

## Acceptance

- [ ] The resolver brief (both branches) instructs reading each side's primary sources (commits, keeper history) to understand intent BEFORE classifying
- [ ] The brief carries an explicit do-not-invent-new-behaviour guard
- [ ] Abort-on-unclear, default-to-BLOCKED-when-unsure, and no-pause discipline are unchanged
- [ ] Daemon test suite is green with assertions covering the new lines in both branches

## Done summary
Grafted an intent-archaeology step (read each side's commits + keeper history before classifying) and a do-not-invent-new-behaviour guard into the shared resolver-brief guardrail array, so both the parse-miss and full branches inherit them; abort-on-unclear, default-to-BLOCKED, and no-pause discipline unchanged. Extended daemon tests to pin both new lines in both branches.
## Evidence
