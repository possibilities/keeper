## Overview

The SUPERVISED finale — NOT for unattended autopilot. Rename keeper's OWN `.planctl/` board (moves the active plan; needs the daemon already watching `.keeper/`), remove the transient `.planctl/` fallbacks, cut the `planctl` cord (binary/promote, buildbot builder, codex symlink), sweep every remaining doc/comment, and archive `~/code/planctl`. Definition of done: `grep -rn planctl` across the live tree returns nothing (bar frozen test fixtures). Run this epic by hand / closely watched — several tasks touch the running daemon, live CI, and irreversible-ish moves.

## Quick commands

- `rg -n 'planctl' ~/code/keeper ~/code/arthack --glob '!**/.git/**'` → 0 (live tree)
- `keeper board` after keeper's own rename — the active plan renders from `.keeper/`
- `ls ~/archive/planctl` — archived

## Acceptance

- [ ] keeper's own `.planctl/` → `.keeper/` (the active board migrated; board still resolves)
- [ ] transient `.planctl/` fallbacks removed from CLI + plan-worker (system reads `.keeper/` only)
- [ ] `planctl` binary build/promote dropped, `~/.local/bin/planctl` gone, buildbot `planctl` builder removed (checkconfig + reload), Codex `/hack` symlink points at the subtree
- [ ] every remaining `planctl` doc/comment swept (keeper + arthack), forward-facing
- [ ] `~/code/planctl` moved to `~/archive/`; `grep -rn planctl` across the live tree returns nothing

## Early proof point

Task `.1` (keeper's own rename) is the riskiest — it migrates the board this very plan lives in. Recovery: the CLI's `.keeper/` primary + `.planctl/` fallback (epic 4) makes `keeper plan` resolve the board post-`git mv`; if the daemon hasn't picked up `.keeper/`, bounce it before renaming.

## Rollout

SUPERVISED. Depends on epics 1–5. Order: keeper rename → remove fallbacks → cut cord → doc sweep → archive+verify. Daemon bounce required before `.1`. Keep the standalone GitHub `possibilities/planctl` remote until after verify (then archive on GitHub, optional).
