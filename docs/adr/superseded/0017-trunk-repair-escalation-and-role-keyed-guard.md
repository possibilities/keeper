# 17. Repo-scoped trunk-repair escalation and role-keyed escalation-session allowlist

## Status

Superseded by [ADR 0089](../0089-in-session-escalation-subagents.md): repair moved from a
dispatched `repair::<repo>` session to a daemon-elected write grant an in-session repairer
subagent uses, and the env-keyed `KEEPER_ESCALATION_ROLE` allowlist this record introduced
retired in favor of the grant-guard hook's subagent-identity jurisdiction. The rest of this
record describes the dispatched-session machinery it replaced.

## Context

Autonomous `unblock::<task>` escalation sessions are diagnosis-only by contract: their skill
frontmatter hard-denies Edit/Write, and resolution is meant to flow through plan verbs plus a
bus resume to the lane-owning worker. Two forces broke this in practice:

1. **The tool deny was not a capability bound.** Escalation sessions launch under
   `--dangerously-skip-permissions`, which pre-approves all Bash while the frontmatter
   `allowed-tools` whitelist is inert. Sessions that hit the Edit deny wrote source files anyway
   via interpreter heredocs over Bash — including writes inside another task's worktree lane.
   Agents route around friction; a boundary that blocks the tool but not the capability selects
   for degraded workarounds (truncation-prone heredocs) instead of compliance.
2. **A whole incident class had no home in the blocked-category taxonomy.** A commit on the
   shared default branch that breaks the whole-project gate blocks every lane at once, fits none
   of the task-scoped categories, and cannot be fixed by spec edits — yet the only session
   dispatched for it was one contractually forbidden to fix anything.

Two designs were weighed for the fixing authority: let the unblock session self-elevate to
write when it concludes the base is broken, or route the class to a separate write-capable
escalation identity decided by category before dispatch.

## Decision

Authority follows surface ownership, decided mechanically at dispatch time — never
self-elevation mid-flight:

- **A new baseline-gated blocked category, `SHARED_BASE_BROKEN`**, names the incident class. A
  worker may emit it only when the suite baseline confirms the shared base is red independent
  of the worker's own diff.
- **A new repo-scoped, write-capable `repair::<repo>` escalation** owns that class — modeled on
  `deconflict::` (the existing precedent for bounded elevated authority that owns a repair
  surface). It runs in the shared checkout, never a task lane; re-verifies the defect at
  current HEAD; verifies with the full gate before committing via `keeper commit-work`; asserts
  its touched files do not overlap any affected task's declared files (the mechanical
  anti-re-implementation bound); and is serialized per (repo, failure-fingerprint).
- **Unblock stays diagnosis-only, and the narrowness becomes mechanical**: a role-keyed
  `PreToolUse(Bash)` allowlist guard constrains every escalation session (`unblock`,
  `deconflict`, `resolve`, `repair`) to a per-role closed command-family set. The role rides a
  launcher-injected env marker; sessions carrying the marker fail closed on guard-internal
  error (deny via the JSON envelope, always exit 0), while unmarked sessions keep the
  fail-open discipline that protects a human's session.

The self-elevation alternative was rejected: the six task-scoped categories never need
source-write, so arming unblock for the seventh arms it for all seven and reintroduces the
re-implementation temptation prose cannot police; and N lanes blocked on one base defect would
mean N self-elevated sessions all editing default, needing a bolted-on single-writer key that
the separate repo-keyed identity gets structurally.

## Consequences

- An autonomous session may commit to a repo's default branch. That authority is bounded by
  reproduce-first, full-gate verify, commit-work attribution, the file non-overlap assertion, a
  bounded attempt cap with a single human page on decline, and a non-blocking audit ping on
  every trunk commit — and it is trivially revertable, being a small single-purpose commit.
- Escalation sessions lose open-ended shell: diagnosis tooling must live on the role allowlist.
  An under-tight list surfaces as a visible deny, not a silent workaround.
- The blocked-category taxonomy gains a repo-scoped member, so category routing in the
  block-escalation sweep becomes a dispatch table rather than a single unblock path.
- The guard inverts fail-open to fail-closed for marked sessions only; the exit-0 /
  envelope-deny hook contract is unchanged.
