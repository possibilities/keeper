## Description

**Size:** S
**Files:** .claude/skills/matt-upgrade/SKILL.md

### Approach

A keeper-repo project skill (native .claude/skills mechanism — loads only for sessions launched in this repo, invisible everywhere else; user-invoked via disable-model-invocation: true). /matt-upgrade reviews upstream mattpocock/skills against the matt plugin's pin and the adoption ledger, and reports what is worth learning or re-syncing — it analyzes and proposes, never lands changes itself. Flow the skill body specifies: (1) read ~/docs/matt-skills-adoption.md first — its pin, adopted/rejected/watching verdicts, and sync log scope the run; missing ledger → say so and stop. (2) Acquire the upstream delta: fetch/refresh the local checkout at /Users/mike/src/mattpocock--skills (shallow fetch fine; clone into the session scratchpad if absent), diff the pin against upstream HEAD — prefer CHANGELOG.md and .changeset entries as the human-readable delta over raw commit ranges. (3) Triage in three buckets, each anchored to the ledger so nothing rejected is re-litigated without cause: drift in the four forked skills (per skill: changed upstream? re-sync recommended? — any re-sync re-applies the fork transform from the plugin README and is a reviewed dependency bump, supply-chain surface, never an auto-merge); new upstream items absent from the ledger (evaluate against keeper's existing coverage; recommend adopt/watch/skip with one-line reasons); watching items that moved (e.g. an in-progress skill graduating). (4) Report in chat: delta summary, per-bucket verdicts with recommendations, and ONE clustered ledger update (new sync-log line, verdict changes) offered for confirmation — write the ledger .md only on the human's yes, never the .yaml sidecar (hook-owned). Any actual re-sync or adoption work routes to plan:defer or a plan. Idempotent: same pin + same upstream HEAD → same report, noting the delta is unchanged since the last sync-log line.

### Investigation targets

*Verify before relying.*

**Required**:
- ~/docs/matt-skills-adoption.md — the seeded ledger this skill reads and maintains (its section shape is the contract)
- ~/code/arthack/claude/matt/README.md — the pin, fork transform, and sync-log conventions
- ~/code/arthack/claude/matt/skills/*/SKILL.md frontmatter — the upstream/upstream-path provenance keys to diff against
- A matt plugin skill's frontmatter — the disable-model-invocation + argument-hint shape to match

### Risks

- Network dependence: degrade gracefully offline (report from ledger + local checkout state, note the fetch failed).
- Scope discipline: recommending and proposing ledger edits only — any pull toward auto-resyncing plugin files is out of contract.

### Test notes

Frontmatter greps (user-invoked flag, parseable frontmatter); behavior is prose — the epic interactive smoke covers a live run.

## Acceptance

- [ ] A keeper project skill named matt-upgrade exists, user-invoked, loading only in keeper-directory sessions
- [ ] Its flow reads the ledger first, acquires the pin-to-HEAD delta preferring changesets, and triages forked-skill drift / new items / watching moves anchored to ledger verdicts
- [ ] The only write it offers is one clustered ledger update on explicit confirmation; re-sync and adoption work route to the plan tooling
- [ ] Offline and missing-ledger cases degrade to an honest report, never an error spiral

## Done summary
Added .claude/skills/matt-upgrade/SKILL.md, a user-invoked native project skill that reads the adoption ledger, diffs the pin against upstream mattpocock/skills HEAD (preferring CHANGELOG/.changeset), triages drift/new/watching buckets anchored to prior verdicts, and proposes one clustered ledger update on confirmation.
## Evidence
