## Overview

keeper's autopilot zellij session intermittently launches with no tab bar.
Root cause: `ensureSession` (`src/exec-backend.ts`) treats an EXITED session
as not-listed and mints via `zellij attach -b <session>`, which RESURRECTS
the cached serialized layout (`session-layout.kdl`) instead of building
fresh — and a degraded cache (empty tabs + a stale zjstatus bar from an
earlier interactive incarnation) renders bar-less. A full restart clears it,
so the bug is latent, not fixed. End state: every keeper-managed autopilot
mint is FRESH (no resurrection), and the resurrection cache is never written
in the first place. Two independent moves: (1) add `--forget` to keeper's
mint argv so each `attach -b` deletes any saved session before connecting;
(2) set `session_serialization false` in the user's dotfiles zellij config so
no session ever serializes to the cache. The session is keeper-exclusive
(humans may peek; keeper is free to treat a dead corpse as disposable).

## Quick commands

- `zellij delete-session --force autopilot 2>/dev/null; # corpse gone, then after a keeper dispatch mints the session:`
- `zellij -s autopilot action dump-layout | rg -c 'zellij:tab-bar'  # > 0 — fresh mint carries a tab bar`
- `rg -n 'session_serialization false' ~/.config/zellij/config.kdl  # serialization disabled`

## Acceptance

- [ ] Every keeper autopilot session mint passes `--forget` so a stale/EXITED corpse is forgotten and the session is built fresh (no resurrection).
- [ ] `session_serialization false` is set in the dotfiles zellij config so no session serializes to the resurrection cache.
- [ ] A dispatched autopilot session renders with a tab bar deterministically (verified after forcing the prior session to EXITED).
- [ ] Existing exec-backend tests updated to assert the new mint argv; no test asserts the old resurrect-the-corpse behavior.

## Early proof point

Task that proves the approach: `<epic>.1` (the keeper `--forget` change is the
structural fix; the dotfiles task is defense-in-depth). If it fails: fall back
to an explicit `delete-session --force` + confirm-gone poll before `attach -b`.

## References

- Overlap (auto-wired): `fn-673` (focuspane exec backend op) edits the same `src/exec-backend.ts` + `test/exec-backend.test.ts` — coordinate to avoid a merge conflict on the mint/`ensureSession` logic.
- Verified zellij 0.44.3 mechanics: `attach --forget` = "Delete saved session before connecting"; `ZELLIJ_CONFIG_DIR`/`default_layout` applies on fresh create but NOT on resurrect; `session_serialization false` (config, "requires restart") disables the serialization cache entirely.

## Docs gaps

- **README.md** (`## Architecture`, ExecBackend prose ~:1330-1333): revise the "lazily-created `zellij_session`" wording in-place to note the session is fresh-minted (`--forget`), never resurrected from a stale serialized layout.
