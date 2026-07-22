# 107. Return-authoritative lock acquisition outcomes

## Status

Accepted. Supersedes ADR 0023, whose original record is retained under
`docs/adr/superseded/`; its merge-window refusal, rollback, durable id-ledger,
and duplicate-detection decisions remain in force, while its environmental
fail-soft-to-unlocked commit-lock clause does not.

## Context

Keeper serializes daemon admission, commit publication, Plan mutations, and
shared sidecar updates with advisory file locks. The lock implementations cross
Bun's experimental FFI boundary: the syscall return and the thread-local error
value are observed separately. Hosted Linux validation has repeatedly observed a
failed nonblocking `flock` return paired with `errno=0` during real contention.
Treating the missing diagnostic as a fatal exception makes healthy contention
fail CI, while treating it as acquisition would permit concurrent protected
work.

The repository also has several lock adapters with different lock-or-null,
boolean, and exception conventions. Plan mutations deliberately proceeded
unlocked when their commit lock was environmentally unavailable. That
availability choice conflicts with the integrity guarantee expected from the
same shared commit lock: an unproven lock cannot authorize a write safely.

## Decision

1. Every advisory lock attempt produces one **Lock acquisition outcome**.
   `Acquired` requires an exact successful syscall return. A failed return with
   positive contention evidence is `Contended`; a failed return without that
   evidence is `Inconclusive`. A stale, missing, malformed, or unreadable error
   value never changes a failed return into acquisition.
2. Interruptions may retry only within the caller's existing bound. A bounded
   attempt may report contention timeout only when its observations positively
   establish contention; uncertainty remains Inconclusive. Every non-acquired
   path closes its invocation-owned descriptor and native-library handle, while
   an Acquired handle retains the exact descriptor through the protected work.
3. Policy remains explicit at the caller boundary. The daemon Single-instance
   lock fails closed before DB access and keeps Contended distinct from
   Inconclusive. Commit publication, worktree integration, and Plan mutations
   retry or refuse before writing; none proceeds unlocked after an Inconclusive
   outcome. Optional refresh and observation work may defer, but never perform
   its protected mutation without Acquired.
4. Root lock consumers share one DB-free classification contract, and
   package-local adapters use the same outcome semantics where package
   boundaries prevent a direct import. Descriptor creation establishes
   close-on-exec atomically on supported platforms so a child cannot retain a
   lock beyond its owner.
5. Deterministic tests inject every return/error class, including a failed
   return with `errno=0`, and prove that only Acquired reaches protected work.
   Focused native-lock smoke runs on the supported Linux and macOS ARM runtimes
   with explicit architecture and Bun-version assertions. Runtime upgrades are
   defense-in-depth; they do not replace the return-authoritative contract.

## Consequences

- Lost error diagnostics can reduce availability or diagnostic precision, but
  cannot create a second lock owner or authorize an unprotected mutation.
- Plan lock infrastructure failures become retryable refusals instead of
  unlocked writes. Operators may see a new Inconclusive outcome where the old
  path continued, preserving the state that needs protection.
- Contention and environmental failure remain independently observable, so a
  live incumbent is not mislabeled as broken infrastructure and broken
  infrastructure is not mislabeled as ordinary load.
- Native smoke remains narrow and repeated; deterministic injected tests own the
  exhaustive correctness proof, while platform smoke detects runtime, ABI,
  libc, and kernel integration regressions.
