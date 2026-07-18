## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/launch-config.ts, src/account-routing-config.ts, test/agent-account-routing.test.ts, test/agent-launch-config.test.ts

### Approach

Investigation-first, two questions then one mechanism. First: why did the
launch chain consult TWO config stores (the resolved account dir, then the
home store) — trace CLAUDE_CONFIG_DIR threading through every hop
(keeper agent -> cswap run -> claude) and PREFER eliminating the home-store
dependency by threading the per-account dir everywhere; only if the home read
is intrinsic to the harness, fall back to seeding both stores. Second: derive
the account config dir from the RouteSelection slot — a pure convention
deriver in the DB-free account-routing-config leaf IF the cswap layout is a
stable contract (verify against the cswap source/binary), else one
cswap-list read in the launcher; record the choice in one comment-free line
of the Done summary. The mechanism: immediately before spawn, for the
realpath-normalized launch cwd (serial checkout or fresh worktree lane), a
field-level merge sets hasTrustDialogAccepted and
hasClaudeMdExternalIncludesApproved true in the relevant store(s) projects
entry, preserving all sibling fields, skip-if-already-true, written via
temp-file + atomic rename; a write failure logs once and the launch proceeds
(the sibling parked-detection task catches the park visibly). The account-*
files may carry foreign uncommitted edits — follow the commit-work ownership
envelope and cooperative release rail; never overwrite foreign work.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts:2930-2977 — route selection (slot + accountOrdinal known here); :2987-3011 settings handling; composeManagedClaudeArgv in src/agent/launch-config.ts:380 (the cswap run wrap — where CLAUDE_CONFIG_DIR threading lives or is missing)
- src/account-router.ts:46 — RouteSelection shape (no config dir today)
- src/account-routing-config.ts — the DB-free leaf where a pure deriver belongs
- events.config_dir evidence: jobs/birth fold at src/reducer.ts:10050-10095 — what the worker actually reported as its config dir

**Optional** (reference as needed):
- test/agent-account-routing.test.ts, test/agent-launch-config.test.ts — byte-pinned argv/env fixtures

### Risks

- cswap layout drift makes a pure deriver silently write the wrong file — the deriver must verify the derived dir exists and fail loudly to the log-once path
- Concurrent claude processes share the home store; only the atomic-rename + skip-if-present contract bounds the race, and eliminating the home write removes it

### Test notes

Deterministic: deriver fixtures (stable layout, absent dir); merge fixtures
(absent entry, partial entry, explicit false, sibling preservation, malformed
JSON fail-soft); env-threading assertion that the spawned argv/env carries the
account config dir on every hop when the eliminate-home path proves out.

## Acceptance

- [ ] A dispatch into a repo absent from the relevant config store(s) launches without any trust or includes dialog, in both serial and worktree modes
- [ ] The config-store set consulted by the launch chain is explicitly established, with the home dependency eliminated or its merge contract (skip-if-present, atomic rename, sibling preservation, fail-soft) implemented and tested
- [ ] The slot-to-config-dir derivation is verified against the live layout and fails loudly to a log-once path when the derived dir is absent
- [ ] Named test gates for the touched suites pass

## Done summary

## Evidence
