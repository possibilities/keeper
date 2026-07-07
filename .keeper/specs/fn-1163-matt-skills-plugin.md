## Overview

A new `matt` Claude plugin at ~/code/arthack/claude/matt/ brings four skills forked from Matt Pocock's MIT-licensed skillset — /matt:teach, /matt:grill-me, /matt:prototype, /matt:improve-codebase-architecture — plus the new-build /matt:init, which migrates an existing repo into the domain-docs world (CONTEXT.md glossary, docs/adr, CLAUDE.md prune) through one clustered human-confirmed proposal. Every plugin skill is user-invoked, so the plugin adds zero context load; the already-wired scan-dir loads it in every interactive session and strips it from autopilot workers with no config change. A keeper-local companion skill, /matt-upgrade, lives outside the plugin (project skill, keeper sessions only) and reviews the upstream repo against the fork's pin and the adoption ledger.

## Quick commands

- `cat ~/code/arthack/claude/matt/.claude-plugin/plugin.json | python3 -m json.tool` — manifest parses
- `grep -L "disable-model-invocation: true" ~/code/arthack/claude/matt/skills/*/SKILL.md` — empty output (all five user-invoked)
- `head -5 ~/docs/matt-skills-adoption.md && head -3 /Users/mike/code/keeper/.claude/skills/matt-upgrade/SKILL.md` — the upgrade skill and its ledger exist
- Interactive smoke: launch claude in any repo and type `/matt:` — five skills appear; `/matt:init` in a scratch repo produces one clustered proposal and waits; in a keeper session `/matt-upgrade` reports the upstream delta since the pin

## Acceptance

- [ ] The matt plugin loads from the scan-dir with five discoverable skills, all user-invoked, none reaching workers
- [ ] The four forks carry pinned provenance (mattpocock/skills@1445797d), the arthack voice, re-tuned trigger descriptions, and no dangling references to Matt-ecosystem skills or machinery
- [ ] MIT attribution is complete: in-plugin LICENSE with verbatim text and copyright, an arthack NOTICES entry, and per-skill frontmatter provenance
- [ ] /matt:init harvests read-only, proposes exactly one clustered delta (empty delta reported honestly), lands only on greenlight via keeper commit-work or defers via plan:defer, and re-runs propose only deltas
- [ ] The plugin inventory docs agree: arthack claude/CLAUDE.md "Plugins by domain" and keeper's plugin-composition-map scan-dir enumeration both name matt
- [ ] /matt-upgrade loads only in keeper-directory sessions, reviews the upstream delta against the pin and the adoption ledger, and proposes ledger updates as one clustered edit — never auto-writing, never auto-resyncing

## Early proof point

Task that proves the approach: task 1 (scaffold + the three mechanical vendors). If it fails: the plugin/manifest conventions were misread — fix the scaffold against the lsp/arthack precedents before the fork tasks start.

## References

- Vendor source: /Users/mike/src/mattpocock--skills at 1445797d (2026-07-02) — the studied tree; upstream moves fast (changesets versioning), re-sync is a reviewed dependency bump, never an auto-merge
- Fork transform (recorded in plugin README): copy verbatim at pin → frontmatter (invocation flag, provenance keys, description re-tune) → address swap ("the user" → "the human") → documented ref repointing
- ~/docs/matt-skills-adoption.md — the adoption ledger: pin, adopted/rejected/watching verdicts, sync log; /matt-upgrade's working memory
- keeper prompt render engineering/domain-docs — the reflex /matt:init mirrors; point, never restate
- keeper prompt render engineering/commit-via-keeper-default — init's landing contract
- plan:defer — init's deferred-landing path; scaffolds a single-task epic, no worker

## Docs gaps

- **~/code/arthack/claude/CLAUDE.md**: "Plugins by domain" gains a matt bullet (task 1 deliverable)
- **/Users/mike/code/keeper/docs/plugin-composition-map.md**: the scan-dir children enumeration gains matt (task 4 deliverable)

## Best practices

- **Pin and log every sync:** upstream is active; per-skill frontmatter pins + the ledger sync log make re-sync a reviewed diff, not a blind merge
- **Re-tune descriptions as trigger conditions:** a description scoped for Matt's ecosystem mis-fires here even on user-invoked skills
- **Vendored prompt-ware is supply-chain surface:** each re-sync is a re-injection point; review file bodies end-to-end before landing
