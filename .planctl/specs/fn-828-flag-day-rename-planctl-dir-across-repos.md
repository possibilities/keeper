## Overview

Big-bang `git mv .planctl .keeper` across the 8 non-keeper repos that carry plan data: agentrender, agentuse, arthack, dotfiles, prosectl, tmux0r, vtkeep, zellijsub. (keeper's OWN dir is the supervised finale; the standalone `planctl` repo leaves with the archive.) Each is an independent, parallel-safe, fully autopilotable task — the daemon (post-epic-4 restart) reads both dir names, so each repo's board stays visible through its own rename.

## Quick commands

- per repo: `cd ~/code/<repo> && git mv .planctl .keeper && git commit`
- `keeper board` — every migrated repo's epics still render (folded from `.keeper/`)

## Acceptance

- [ ] all 8 repos renamed `.planctl/` → `.keeper/` via `git mv` + committed
- [ ] each repo's `.keeper/CLAUDE.md` + any in-repo `.planctl/` path refs updated to `.keeper/`
- [ ] `keeper board` renders every migrated repo's plan from `.keeper/`

## Early proof point

Any one repo task proves the mechanic. If a repo's board goes dark after rename, the daemon hasn't picked up epic 4's `.keeper/` watch — bounce it.

## Rollout

Fully autopilotable (parallel across repos) ONCE epic 4 has landed AND the daemon has been restarted to watch `.keeper/`. Hard-gated on epic 4.
