# 0082 — Hash-gated durable close-phase resume

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

A close attempt persists the quality report, verdict, follow-up document, and
follow-up cell-selection artifacts before `close-finalize` performs its
irreversible work. A transient finalize refusal can therefore leave a complete,
fresh audit pipeline on disk. Redispatching the close and unconditionally
running every agent again is expensive and can produce a divergent verdict or a
duplicate follow-up even though no source commit changed.

Dispatch ownership and cleanup already survive retries through attempt-fenced
clears ([ADR 0070](0070-attempt-and-incident-fenced-dispatch-clears.md)). The
blocking-follow-up path already derives a durable short-circuit from board state
([ADR 0028](0028-blocking-followup-close-gate.md)). The finalize-deferral
lineage from [ADR 0031](superseded/0031-finalize-defers-on-occupying-closer.md)
to [ADR 0055](0055-harness-activity-dispatch-claims-and-resource-holds.md)
keeps logical finalization separate from session and resource lifetime. None of
those decisions says whether persisted close-phase content is still valid for a
new attempt.

File presence alone is insufficient. A report can be torn from its metadata, a
new source commit can make every downstream decision stale, and the selection
verdict is derived from the follow-up document rather than directly from the
source commit set.

## Decision

`close-preflight` emits a nullable `phase_resume` process fact beside
`blocking_followup`. The close coordinator consumes this typed envelope and does
not inspect audit files itself. An empty close-phase artifact set emits `null`,
preserving the ordinary fresh-close path.

A deterministic audit-artifact validator grades the audit, plan, and selection
phases as `satisfied`, `not_needed`, or `unfinished`.

- Audit requires both `report.md` and schema-readable `report.meta.json`; the
  metadata's `commit_set_hash` must equal the fresh hash from the same
  lane-aware `findCommitGroups(..., epicId)` derivation used by finalize.
- A zero-finding audit makes plan and selection `not_needed`. Otherwise plan
  requires a schema-readable, hash-fresh verdict. A fatal verdict satisfies plan
  and makes selection `not_needed`. A non-fatal verdict with surviving clusters
  also requires the follow-up document and its schema-readable, hash-fresh
  metadata; no surviving cluster makes selection `not_needed`.
- Selection is chained on a satisfied follow-up-producing plan. Its brief and
  verdict must be schema-readable, and both `input_hash` values must equal the
  SHA-256 of the exact persisted follow-up document bytes. A fresh verdict path
  is emitted only when those checks pass.

Invalidation is ordered. The first missing, torn, malformed, too-new, or stale
applicable phase is `unfinished`, and every downstream phase is also
`unfinished`; downstream files cannot rehabilitate an invalid upstream fact. In
particular, a stale audit stamp causes a full re-audit. A too-new artifact schema
is treated as unusable phase input rather than making preflight fail, so an older
binary safely recomputes instead of guessing at future content.

The envelope also carries only the branch facts needed to choose the next
process step: finding count, fatal flag, whether a fresh follow-up is present,
and the fresh selection-verdict path. It does not add a `CloseOutcome`; finalize
retains its existing total outcome switch and fresh commit-set refusal.

## Consequences

- A close redispatched after a transient finalize refusal can resume at the
  first unfinished phase without spawning agents for already satisfied work.
- A moved lane-aware commit set deterministically invalidates the report and all
  decisions derived from it, including apparently complete downstream files.
- Zero-finding and fatal branches preserve their normal skipped-phase behavior
  without manufacturing missing work.
- Selection freshness follows the document it selects, while report, verdict,
  and follow-up freshness follow the source commit set; the two hashes cannot be
  substituted for one another.
- Runtime artifacts remain gitignored and replaceable. Their authority comes
  from schema and hash validation on each preflight, not from age, attempt id,
  session liveness, or file presence alone.
