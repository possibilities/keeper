## Description

Originating findings: F1 (kept) and F3 (merged-into-F1), both from the
fn-789 audit. Evidence path: docs/exec-backend.md:178-182 ("Session-gone
single-retry") states that on a `new-tab` / `new-window` failure `launch`
invalidates the memo, re-ensures, and retries once — but the tmux backend's
`launchInto` (src/exec-backend.ts:748-772) runs `ensureSessionFor` ->
`new-window` exactly once with NO session-gone retry and NO memo (a
per-call `has-session -t =<session>` probe each launch instead, per the
module JSDoc at src/exec-backend.ts:663-665). The zellij `launch`
(src/exec-backend.ts:440-451) is the only path with the documented
memo-invalidate-and-retry arm.

F3 bundles here because it is the regression-pin for exactly this
divergence — same root cause (the tmux retry contract) and same
file-touch theme (the exec-backend tmux launch path) — so the doc
correction and its guarding test land as one commit.

Scope: (a) scope the "Session-gone single-retry" paragraph to zellij, or
add tmux's per-call-probe alternative so the doc no longer claims a tmux
retry; (b) add a test that pins tmux `launch` does NOT retry on a
session-gone `new-window` failure (the inverse of the existing zellij
retry tests).

## Acceptance

- [ ] docs/exec-backend.md no longer claims tmux performs a session-gone
  `new-window` retry; the paragraph either scopes to zellij or describes
  tmux's per-call `has-session` probe as the alternative.
- [ ] A test asserts tmux `launch` issues exactly one `new-window` (no
  re-ensure, no second attempt) on a session-gone failure stderr.

## Done summary
Scoped the exec-backend.md session-gone single-retry paragraph to zellij and documented tmux's per-call has-session probe alternative; added a regression test pinning that tmux launch issues exactly one new-window (no re-ensure/retry) on a session-gone failure.
## Evidence
