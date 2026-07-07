## Overview

A keeper-local project skill, /matt-upgrade, reviews upstream mattpocock/skills against the matt plugin's pin and the adoption ledger at ~/docs/matt-skills-adoption.md — reporting forked-skill drift, triaging new upstream items against prior verdicts, and offering one clustered ledger update. It analyzes and proposes only; re-sync and adoption work route to the plan tooling. Native project-skill loading keeps it visible solely in keeper-directory sessions.

## Quick commands

- `head -3 .claude/skills/matt-upgrade/SKILL.md` — the skill exists with frontmatter
- `grep -c "disable-model-invocation: true" .claude/skills/matt-upgrade/SKILL.md` — 1
- Interactive smoke: in a keeper session run /matt-upgrade — it reads the ledger, reports the pin-to-HEAD delta, and offers one clustered ledger edit

## Acceptance

- [ ] /matt-upgrade loads only in keeper-directory sessions, user-invoked
- [ ] A run reads the ledger first, acquires the upstream delta preferring changesets, and triages drift / new items / watching moves anchored to ledger verdicts
- [ ] Its only write is one clustered ledger update on explicit confirmation; all re-sync or adoption work routes to plan tooling
- [ ] Offline and missing-ledger cases degrade to an honest report

## Early proof point

Task that proves the approach: task 1 (the whole epic). If it fails: the project-skill mechanism was misread — verify .claude/skills loading in a live keeper session before rework.

## References

- ~/docs/matt-skills-adoption.md — the seeded adoption ledger (pin mattpocock/skills@1445797d, adopted/rejected/watching, sync log)
- ~/code/arthack/claude/matt/README.md — the fork transform + sync-log conventions; per-skill frontmatter provenance keys
- Upstream is changesets-versioned and active — re-sync is a reviewed dependency bump, supply-chain surface, never an auto-merge
