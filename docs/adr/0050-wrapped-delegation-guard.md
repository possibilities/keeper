# 50. Wrapped-cell total-edit-denial guard and dumb-courier contract

## Status

Accepted. Builds on
[ADR 0010](0010-host-provider-matrix-and-wrapped-worker-cells.md),
[ADR 0047](0047-provider-equivalence-map-and-worker-provider-pin.md), and the
marker-keyed guard model in [ADR 0025](0025-wrong-tree-write-guard.md).

## Context

A wrapped work worker delegates implementation to a foreign provider. Prompt text
alone cannot stop its Claude wrapper from editing source, running repository code,
launching an unrelated writer, or closing another task. The wrapper still needs a
small launch, observation, handoff, and close-out surface.

## Decision

Every work launch emits `KEEPER_WRAPPED_CELL` and `KEEPER_WRAPPED_ENVELOPE` through
the shared exec seam. Native cells receive empty values. Wrapped cells receive the
effective cell and a per-task envelope path whose basename binds the launch task.
Jurisdiction requires both a non-empty marker and subagent identity in the tool
payload; human and orchestrator turns remain inert.

`wrapped-guard` is a fail-closed
`PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash)` guard. Edit, MultiEdit, and
NotebookEdit are always denied. A handoff Write is eligible only for a fresh
`.json`, `.txt`, or `.md` leaf in a newly created owner-private system-temp
directory. The guard writes the bounded content itself with exclusive, no-follow,
close-on-exec descriptor flags, then denies the host Write with an
`ATOMIC_HANDOFF_WRITTEN` receipt. Existing leaves are never reopened, eliminating
the validation-to-open hardlink window.

Bash uses a positive allowlist. It permits the exact private-temp `mktemp` shape,
launch-bound non-Claude provider runs, bounded wait/read operations, task-bound
`commit-work`, task-bound non-forced `plan done`, bounded Plan/session/baseline
reads, and selected Git reads. Provider runs must carry the wrapped session,
literal task name, injected envelope reference, timeout, and initial system file
or resume target. Generic/nested Claude agents are denied.

Raw index/ref Git and repository-defined scripts/tests are denied. Git reads that
can consult configuration require fixed `core.fsmonitor=false`, `core.pager=cat`,
and `--no-pager` arguments; diff/log/show also require `--no-ext-diff` and
`--no-textconv`. Exec-bearing flags, config injection, signatures, filters,
textconv, external diff, pagers, shell operators, redirects, substitutions,
interpreters, and re-entrant wrappers remain off-list.

The wrapper is a dumb courier. It sends implementation, test, and lint iteration
back to the same provider leg, treats provider output as bounded untrusted data,
derives the actual path set from Git, and supplies fresh descriptor-written
manifest/message files to `commit-work`. It never authors source or executes
repository code itself.

## Consequences

- Prompt drift cannot grant the wrapper a native source-edit path.
- Provider code runs only through the constrained launch-bound leg shape.
- Completion and commit authority cannot target another task or use `--force`.
- Handoff bytes cannot truncate an existing hardlink target.
- Provider tests remain provider-side; Keeper independently runs its scoped gates.
- Adoption stays invocation-local and retains foreign-claim, byte/mode, hook,
  signing, and compare-and-swap protections.
- Every new launch producer must emit both wrapped carriers through the shared seam.
