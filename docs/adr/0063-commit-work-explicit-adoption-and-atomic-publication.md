# 63. Explicit work adoption and atomic isolated-index publication

## Status
Accepted. Extends the shared-checkout safety model and the wrapped-worker contract in
[ADR 0050](0050-wrapped-delegation-guard.md).

## Context
A dirty path is not necessarily authored by the committing session. Tool, Plan, Bash,
package-manager, code-generation, daemon-ingest, and Git observations arrive on different
clocks. Publication also crosses executable clean filters, linters, hooks, signers, and
remote transport. Selection must fail closed without turning observation into ownership,
and the selected bytes must remain fixed until one ref compare-and-swap.

## Decision
### Authority and ownership
Every invocation binds to a currently working tracked Claude or Pi job. A UUID or environment
carrier is only a hint: the job's exact `(pid,start_time)` must occur on the caller's bounded OS
ancestry chain. Equal full authority rows sandwich that walk, and unsupported/NULL harness or
pid-only rows fail closed. A requested task must equal that work job's task. Authority is sampled
again after each final ownership scan immediately before publication.

Automatic selection admits only exclusive tool/Plan/direct claims belonging to that identity.
Bash, inferred, package-manager, and codegen evidence is observation only. Missing or ambiguous
evidence fails closed. `--adopt` and bounded descriptor-read manifests name exact paths for one
invocation and create no durable ownership. Live or unknown foreign exclusive claims block;
only positively terminal claims are adoptable. If durable evidence is unavailable, complete
synchronous overlap evidence is required. Fresh pending/receipt mutations use projected
`working` only as positive live evidence; every other projected state remains unknown until fold.

One SQLite snapshot reads durable claims, root watermarks, event head, and pending rows under hard
row/byte caps. Authority readers and hook producers use fixed OS-user receipt/dead-letter stores;
environment overrides cannot hide evidence. Receipt and dead-letter tails use stable bounded
regular descriptors, with event heads and monotonic dead-letter import state sandwiching source
handoffs. Canonical aliases and legacy paths relative to their recorded cwd are normalized before
overlap classification.

### Observation-bound attribution
Immediately before each Git read, producers capture inclusive `MAX(events.id)`. Reducers admit
mutation evidence only in `(prior,captured]`; synthetic snapshot IDs are publication order, not
observation fences. Missing, stale, malformed, or future watermarks no-op. Dropped roots retain a
sentinel floor; never-observed roots scan from genesis. Folds remain deterministic and bounded.
Claude hooks and the ephemeral Pi extension sandwich `realpath` with stable device/inode/type
reads and fall back to a parent-canonical lexical leaf on any swap. Pi adapts successful native
`write`/`edit` results to canonical cross-harness names and never claims failed tool calls.

### Frozen identity and bounded execution
Under a close-on-exec worktree flock, Keeper captures branch/parent (including an unborn branch)
and constructs a private index from exactly the sorted selected path/kind/mode/blob set, including
deletions and both rename halves. The resulting tree is immutable. Ambient staged carryover
refuses unless the narrow
override losslessly restores exact base entries. Unmerged paths, operations, jams, mass reversion,
stale indexes, and compare-and-swap conflicts retain typed refusals.

Before executable filters, Keeper captures dirty, untracked, and individually enumerated ignored
bytes between equal helper-disabled status path sets; primary/split indexes; effective config;
hooks; signing policy; and selected tree identity. Raw inputs, messages, fingerprints, samples,
outputs, and result envelopes have explicit ceilings. Every Git/tool process has a finite bound;
timeout refuses publication and kills the process group plus observed/token-bearing descendants.
Repository executables are trusted same-user programs and must not intentionally escape that OS
boundary. Package lint fan-out is concurrent and capped; domain-doc reads are descriptor-bound.

### Hooks, signing, CAS, and push
Keeper fingerprints `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, and
`reference-transaction`, and descriptor-captures executable commit-hook bytes between equal source
fingerprints. Only private copies execute. Hooks may change prose but must preserve the exact
multiset of Task, session/job, Keeper marker, signoff, and `Planctl-*` trailers. Any frozen surface,
index, branch, config, hook, operation, or ownership mutation aborts.

Signing policy is captured between equal complete-config fingerprints; signer format, key, and
program selection are pinned at command scope. `commit-tree` receives the immutable tree/parent and
bounded message, and its object is verified after signing. Publication is one timed CAS
`update-ref` with hooks pinned to an empty private directory. An executable `reference-transaction`
hook is refused because it cannot compose atomically with Keeper's protocol. A moved ref is never
rolled back. A CAS timeout/output loss is explicitly indeterminate and is never retried or pushed
without inspection. `post-commit` runs captured bytes after CAS; failure/replacement is
committed-local. Push uses the exact commit SHA and captured branch. A timeout, signal, or output
loss yields `pushed:null`; tracking changes occur only after confirmed remote success.

### Wrapped close-out and explainability
Wrapped workers use fresh atomic handoffs, constrained launch-bound provider legs, helper-disabled
Git reads, and literal launch-task `commit-work`/non-forced `plan done`. Provider text never enters
a shell command. One bounded versioned result partitions selected, adoptable, foreign-conflicting,
ambiguous, excluded, and staged paths and carries commit/push state plus truncated counts/samples.
