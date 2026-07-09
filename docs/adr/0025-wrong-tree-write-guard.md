# 25. Wrong-tree write guard for worktree-lane workers

## Status

Accepted

## Context

Worktree mode gives each ready task its own isolated lane checkout so parallel workers never
contend on one working tree. A lane worker's tool-call surface (Write/Edit/MultiEdit, plus Bash
redirects/heredocs/`tee`/`sed -i`) is not itself lane-scoped: nothing before this guard stopped
a lane worker from resolving a relative or absolute path that lands inside a different tracked
repo working tree — most dangerously the shared main checkout that worktree-mode's merge and
repair machinery depends on staying clean. A write that lands there dirties a tree other
sessions (recover pass, repair sessions, the human's own checkout) assume is untouched, and can
starve the repair route for a shared-base incident that needs that checkout clean to operate.

The mechanical half of this problem — stopping the write before it lands — is amenable to a
`PreToolUse` hook keyed on the lane path already injected at launch (`KEEPER_PLAN_WORKTREE`).
The hook cannot be a hard security boundary: Bash write-vector extraction is string parsing, not
execution, so TOCTOU between the check and the actual write is unavoidable, and a hook that
fails closed on its own internal error risks wedging a human's own session (the same fail-open
default followed by branch-guard).

## Decision

Add `wrong-tree-guard`, a `PreToolUse(Write|Edit|MultiEdit|Bash)` hook, as a best-effort audit
layer, not a security boundary:

- **Marker-keyed jurisdiction**, mirroring escalation-guard: the launch-injected lane path
  `KEEPER_PLAN_WORKTREE` (realpath-normalized at the worker's child boundary) decides whether the
  hook has anything to say. Marker absent or empty (serial launches, and the human's own
  session) means the hook is inert and allows everything with no output.
- **Scope of the check**: when the marker is set, a write target must resolve inside the lane,
  be plan state (`.keeper`), or be outside every tracked repo; anything else — most notably a
  path that resolves into a different tracked repo's working tree, including the shared main
  checkout — is denied via the `PreToolUse` JSON deny envelope.
- **Fails open**, inverting escalation-guard's fail-closed stance: any internal error in the
  guard allows the tool call through rather than blocking it, because a wedged human session is
  worse than an occasional missed audit.
- **Best-effort, not exhaustive**: Bash vector extraction covers redirects, heredocs, `tee`, and
  `sed -i` by string parsing; it does not attempt to be a complete shell interpreter, and
  `.ipynb`/`notebook_path` coverage was scoped out as negligible in a Bun/TS repo.

## Consequences

- A lane worker's stray write into another tracked repo's working tree — in particular the
  shared main checkout — is denied before it lands, in the common case, closing the mechanical
  half of the shared-checkout-dirtying failure mode.
- The guard is not a substitute for the recover pass or repair sessions: a determined or
  TOCTOU-timed write can still land, so those stay the backstop for a dirtied shared checkout.
- Like branch-guard, this hook must never fail closed on its own internal error, or a bug in the
  guard becomes a wedged human session — the same tradeoff already accepted repo-wide for
  best-effort audit hooks.
