## Overview

The Stop docs-pusher serializes concurrent sessions with a bare O_EXCL
`.git/keeper-push.lock`, released only in `pushDocs`'s `finally`. If the Stop
hook is hard-killed between acquire and release (the harness can time out a
hook; `GIT_TIMEOUT_MS` is 8s), the lockfile is orphaned and EVERY future docs
push silently returns `locked` — the human's `~/docs` stops reaching the remote
with no signal. This follow-up makes the lock self-reclaiming and makes a stuck
lock visible, preserving the fail-open / exit-0 hook contract.

## Acceptance

- [ ] An orphaned push lock (holder pid gone, or lock older than a threshold
      comfortably above `GIT_TIMEOUT_MS`) is reclaimed on the next push instead
      of blocking it forever.
- [ ] A skipped push on the `locked` path is at least visible (logged), so a
      stuck lock is diagnosable.
- [ ] The misleading "self-heals on the operator's next manual push" comment is
      corrected to match actual behavior.
- [ ] The pusher still always exits 0 and never rebases / force-pushes.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | docs-pusher.ts:257-276 — bare O_EXCL lock, release only in pushDocs finally; a hook-timeout kill orphans .git/keeper-push.lock and every later push silently returns locked forever. |
| F2 | culled | —  | doc-commit.ts:153 verbatim porcelain slice is edge-only (non-ASCII/whitespace ~/docs filename), fails open and re-commits on next write — below the keep bar. |
| F3 | culled | —  | sidecar-writer.ts:378 mis-subjects an under-docs move as delete but commit content is correct — cosmetic, already acknowledged in-code. |

## Out of scope

- The porcelain-v1 quotePath / `-z` robustness in `dirtyFilesForPathspecs` (F2, culled — edge-only, fails open).
- The `delete`-verb subject on an under-docs move in `handleDocsDelete` (F3, culled — cosmetic, content correct).
