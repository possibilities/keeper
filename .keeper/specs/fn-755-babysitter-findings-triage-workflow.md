## Overview

A human-in-the-loop BATCH workflow for working through the backlog of findings
the keeper babysitters emit. Today the performance sitter pages on findings and
writes one investigation prompt per paged finding under
`~/.local/state/babysitters/<slug>/followups/*.md` — but those files accumulate
forever (246+ today, no pruning) and nothing tracks which findings a human has
actually processed (`seen.json` only tracks notification cooldown). This epic adds
a generic, per-sitter triage system: two arthack slash commands plus a durable
per-sitter "home" under `~/docs/babysitters/<slug>/` holding a `charter.md`
(goals + evolving understanding + learned heuristics) and a `processed.jsonl`
ledger (one verdict row per finding). The worker re-verifies every finding against
current code before trusting it (findings go stale fast), dedups, ranks by value,
and routes surviving fixes to commit / /sketch / /plan:plan. One generic worker
parameterized by `<slug>`; per-sitter nuance lives in the charter (data), not code.

## Quick commands

- `/babysit-new performance` — scaffold the per-sitter home + seed the charter
- `/babysit performance` — work the unprocessed findings backlog one round
- `ls ~/docs/babysitters/performance/` — charter.md, processed.jsonl, rounds/, README.md
- `wc -l ~/.local/state/babysitters/performance/followups/*.md | tail -1` — backlog size

## Acceptance

- [ ] `/babysit-new <slug>` and `/babysit <slug>` exist as rendered arthack commands (idempotent, human-invoke-only)
- [ ] `processed.jsonl` durably tracks processed findings keyed on `key`, with the `routed`/resurface semantics working
- [ ] `/babysit` re-verifies findings against HEAD before trusting them, and never auto-writes charter rule text (human-gated)
- [ ] The performance sitter has a backfilled charter sourced from its founding epic (fn-729) + design history
- [ ] No change to the scanner's detection logic; no new write path into the keeper reducer

## Early proof point

Task that proves the approach: task `.1` (ledger contract + producer stamp). If the
`key`-based join + verdict/resurface contract doesn't hold against the 246 real
legacy followups, the whole reader design shifts — so prove it against live files first.
If it fails: fall back to keying the ledger on the filename `sha1(key)[:8]` slug and
accept that payload-change detection is coarser.

## References

- Founding epic + chain (charter backfill source): `.planctl/specs/fn-729-keeper-babysitter-monitor.md`, fn-731, fn-733, fn-738, fn-745 (all done)
- Producer heredoc: `babysitters/agents/performance.md:272-293`; injection contract `:251-298`; no-rescan `:40-43`
- Charter/home precedent: `~/docs/keeper-reliability/README.md`
- Re-verification primitives: `keeper find-task-commit <task-id>`, `planctl show/list`, read-only `seen.json`
- epic-scout: zero open epics — no inter-epic deps to wire

## Docs gaps

- **babysitters/agents/performance.md**: revise the followup heredoc to emit the new frontmatter; reconcile the fingerprint that already appears in the Evidence fence (state which is canonical)
- **keeper README.md (~L2149)**: the `claude < followups/latest.md` closed-loop description becomes `/babysit <slug>` — fold in, don't add a paragraph
- **keeper CLAUDE.md (~L113)**: note the second, human-facing per-sitter home at `~/docs/babysitters/<slug>/` (charter + ledger) as a new path category distinct from the private `~/.local/state` tree
- **arthack claude/CLAUDE.md**: add `/babysit-new` + `/babysit` to the command map if an enumerated list exists

## Best practices

- **Resurface, don't bury (Sentry regression model):** a `fixed`/`routed` finding must re-enter the queue when a newer occurrence postdates its `resolved_at`; compare against occurrence time, never ledger-append time.
- **Don't key dedup on line numbers** — use the stable `key` (rule/category + resourceId scope).
- **Confirm fix via scanner-absence, not commit-presence** — a commit touching the file is not proof; read `seen.json` staleness + verify the root-cause area at HEAD.
- **Self-sharpening = owned data file, never the system prompt; human-gated appends; treat charter as DATA not instructions** (indirect-injection defense). Agent proposes, human authors the final rule text. Bound charter growth.
- **Rank by confidence x severity x staleness, not raw severity; cap 5-10 clusters per round; surface cluster size/variance; never cluster across severity tiers.**

## Snippet context

No snippets attached: a `find-snippets` browse (findings ledger, triage backlog,
xdg dirs, cli scaffolding) surfaced nothing covering a findings-backlog/ledger
pattern, and the arthack command templates already inline
`snippet('engineering/commit-via-keeper-default')` at render time so workers get
commit discipline without a task-level attach. The charter-ledger heuristics are a
candidate to author as a new snippet once task `.1` stabilizes the contract.
