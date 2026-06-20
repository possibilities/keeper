## Description

**Size:** M
**Files:** commands/babysit-init.md (new), commands/babysit-triage.md (new), babysitters/FINDINGS-LEDGER.md, babysitters/agents/performance.md

### Approach

Create keeper's first `commands/` dir and land the two renamed command files,
sourced from the ALREADY-RENDERED flat markdown in arthack (the Jinja snippet is
already expanded inline — nothing to fork, no render pipeline in keeper). Then
update the two live keeper babysitter docs. Stage ONLY this task's paths — the
keeper tree is already dirty with unrelated files; never `git add -A`.

1. `mkdir -p ~/code/keeper/commands`.
2. `commands/babysit-init.md` ← copy of `~/code/arthack/claude/arthack/commands/babysit-new.md`. Set frontmatter `name: babysit-init` (display label; the FILENAME stem `babysit-init` is what actually names the command). Preserve `description`, `argument-hint`, `allowed-tools`, `disable-model-invocation: true` verbatim.
3. `commands/babysit-triage.md` ← copy of `~/code/arthack/claude/arthack/commands/babysit.md`. Set frontmatter `name: babysit-triage`. Preserve `argument-hint: "[slug] [--sweep]"`, `allowed-tools`, `disable-model-invocation: true` verbatim. Drop the trailing `— see [[commit-hygiene-flags]]` from the `**Never** ...` line (the flags are already spelled out on that same line; just remove the dangling wikilink suffix).
4. In BOTH new files, rewrite every internal command self-reference. **Order matters:** replace `/babysit-new` → `/babysit-init` FIRST, then `/babysit` → `/babysit-triage` (a naive `/babysit`→`/babysit-triage` first would corrupt `/babysit-new` into `/babysit-triage-new`). Known sites: babysit-triage body at lines ~19, ~56-57, ~265, ~276, ~335 (`/babysit-new $0`, `re-run /babysit $0`, `/babysit $0 --sweep`); babysit-init body at lines ~13, ~33, ~68, ~78, ~82-83, ~94 (`/babysit $0`, `/babysit-new $0`). These files reference ONLY these two commands, so a scoped two-pass replace WITHIN each file is safe — this is NOT the forbidden repo-wide bulk replace.
5. Leave `$0` arg placeholders exactly as-is — they render literally in both repos, invariant under the move; not in scope.
6. `babysitters/FINDINGS-LEDGER.md`: line 4 "The two **arthack** commands `/babysit-new <slug>` and `/babysit <slug>`" → "two **keeper** commands `/babysit-init <slug>` and `/babysit-triage <slug>`" (and note they now live under `~/code/keeper/commands/`); lines 45, 50 `/babysit` → `/babysit-triage`; line 52 `/babysit-new` → `/babysit-init`. Same init-before-triage ordering.
7. `babysitters/agents/performance.md`: lines 266, 273 `/babysit` → `/babysit-triage`.
8. (OPTIONAL, not a gate) keeper `README.md` ~L2347: a one-line fold-in mentioning `/babysit-triage <slug>` near the closed-loop note. Skip if it doesn't read naturally — there is no existing slash-command string to update there.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/claude/arthack/commands/babysit-new.md — source for babysit-init.md (rendered, flat, snippet already inline)
- ~/code/arthack/claude/arthack/commands/babysit.md — source for babysit-triage.md; the `[[commit-hygiene-flags]]` wikilink to drop lives on the `**Never** --no-verify ...` line
- ~/code/keeper/skills/await/SKILL.md — the precedent shape for a keeper-shipped plugin asset (frontmatter + body, no registration)
- babysitters/FINDINGS-LEDGER.md:1-55 — the doc refs at lines 4, 45, 50, 52 and the "two arthack commands" framing
- babysitters/agents/performance.md:260-280 — the `/babysit` refs at lines 266, 273

**Optional:**
- ~/code/keeper/.claude-plugin/plugin.json — confirm no `commands` key (auto-discovery holds; do NOT add one)

### Risks

- Renaming only the frontmatter `name:` without renaming the FILE would leave the command invoked as the old name — the filename stem is authoritative. Both must change.
- A missed in-body self-ref ships a command that tells the human to run a now-dead command name (e.g. the home-gate error). The grep in Acceptance is the backstop.
- Bulk find-replacing `/babysit` across the repo would rewrite archival fn-7xx specs and scanner-context `babysit` strings. Edit only the four named files, surgically.

### Test notes

- After writing, confirm: `grep -c babysit-new commands/babysit-init.md commands/babysit-triage.md` returns 0 (no old scaffold-command name survives), and `git grep -nE '/babysit( |$|`)' -- commands babysitters | grep -vE 'babysit-(init|triage)'` is empty (no bare old `/babysit` left in live files).
- Optional sanity: load keeper as a plugin (`claude --plugin-dir ~/code/keeper`) and confirm `/keeper:babysit-triage` resolves with its argument-hint.

## Acceptance

- [ ] `commands/babysit-init.md` + `commands/babysit-triage.md` exist, renamed at filename AND frontmatter `name:`, with `disable-model-invocation: true` / `argument-hint` / `allowed-tools` preserved verbatim
- [ ] Every in-body self-reference in both files is rewritten (init-before-triage), and the `[[commit-hygiene-flags]]` wikilink tail is gone from the triage command
- [ ] `babysitters/FINDINGS-LEDGER.md` (4/45/50/52) and `babysitters/agents/performance.md` (266/273) name the new commands; "two arthack commands" reworded to "two keeper commands"
- [ ] No `commands` key added to `plugin.json`; no `git add -A` (only this task's paths staged)
- [ ] Committed via `keeper commit-work` from `~/code/keeper`

## Done summary
Landed keeper commands/babysit-init.md + commands/babysit-triage.md (renamed from arthack's babysit-new/babysit), rewrote in-body self-refs init-before-triage, dropped the dangling [[commit-hygiene-flags]] wikilink, and updated FINDINGS-LEDGER.md + agents/performance.md to the new names.
## Evidence
