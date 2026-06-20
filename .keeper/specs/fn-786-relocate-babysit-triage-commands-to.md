## Overview

The two babysitter findings-triage slash commands — `/babysit-new` (scaffold a
sitter's triage home) and `/babysit` (work one round of the findings backlog) —
currently live in the arthack repo as rendered command templates, even though
every path, contract, and reference they touch is keeper-domain. This epic
relocates them into keeper as plain static plugin commands AND renames them for
clarity: `/babysit-new` → `/babysit-init`, `/babysit` → `/babysit-triage`. End
state: keeper ships `commands/babysit-init.md` + `commands/babysit-triage.md`
(invoked as `keeper:babysit-init` / `keeper:babysit-triage`, parallel to the
existing `keeper:await` skill), arthack no longer carries the templates or
rendered output, and every live doc reference across keeper + `~/docs` names the
new commands. No code logic, schema, or test changes.

## Quick commands

- `test -f ~/code/keeper/commands/babysit-triage.md && test -f ~/code/keeper/commands/babysit-init.md` — both keeper commands exist
- `grep -q '^name: babysit-triage' ~/code/keeper/commands/babysit-triage.md` — frontmatter name renamed (display label)
- `! test -e ~/code/arthack/claude/arthack/commands/babysit.md && ! test -e ~/code/arthack/claude/arthack/template/commands/babysit.md.tmpl` — arthack source + rendered output gone
- `git -C ~/code/keeper grep -nE '/babysit(-new)?( |$|`)' -- commands babysitters | grep -v babysit-init | grep -v babysit-triage` — no stale old-name refs remain in live keeper command/doc text (empty = clean)

## Acceptance

- [ ] `keeper:babysit-init` and `keeper:babysit-triage` ship as static `commands/*.md` files in keeper, renamed at both filename and frontmatter `name:`, with `disable-model-invocation: true`, `argument-hint`, and `allowed-tools` preserved verbatim
- [ ] Both command bodies have every internal self-reference rewritten to the new names (init-before-triage ordering), and the dangling `[[commit-hygiene-flags]]` wikilink tail dropped from the triage command
- [ ] All live keeper docs (`babysitters/FINDINGS-LEDGER.md`, `babysitters/agents/performance.md`) name the new commands; the "two arthack commands" framing becomes "two keeper commands"
- [ ] arthack carries neither the `.md.tmpl` templates, the rendered `commands/babysit*.md`, their `.managed-file-dont-edit` sidecars, nor the babysit `used-in:` entry in the snippet `_index.yaml`
- [ ] All live `~/docs` references (`babysitters/performance/{README.md,charter.md}`, `arthack-claude-plugin-inventory.md`) name the new commands + keeper location
- [ ] Archival `.planctl/specs/fn-755-*` and other historical records are left untouched; no bulk find-replace of `/babysit` across any repo
- [ ] A cross-repo grep sweep confirms no live reference to the old command names survives (archival specs + transcripts excluded)

## Early proof point

Task that proves the approach: `.1` (keeper command files land + render correctly
as `keeper:babysit-*`). If it fails — e.g. the filename-stem rename doesn't take or
a self-ref is missed — fix the file/frontmatter and re-verify before the arthack
removal (`.2`) strands the commands with no source.

## References

- Descends from the completed epic `fn-755-babysitter-findings-triage-workflow` (which created these commands in arthack). fn-755 is DONE/archival — not a dependency; do not edit its specs.
- Naming mechanism (verified vs official Claude Code docs): for a `commands/*.md` plugin file, the slash-command name is the FILENAME STEM; frontmatter `name:` only sets the display label. The file rename is load-bearing.
- No manifest edit: keeper's `.claude-plugin/plugin.json` has no `commands` key, so the default `commands/` dir auto-discovers (same as `skills/await/`).
- arthack cleanup is ONE command: `promptctl render-plugin-templates --project-root ~/code/arthack` runs `build-snippets` internally (run_render_plugin_templates.py:644-650) then prunes orphaned command outputs + sidecars.
- No open-epic dependencies or overlaps (epic-scout: fn-784, fn-785 unrelated).

## Docs gaps

- **keeper `babysitters/FINDINGS-LEDGER.md`** (lines 4, 45, 50, 52): rename command refs; reword "two arthack commands" → "two keeper commands" + keeper location.
- **keeper `babysitters/agents/performance.md`** (lines 266, 273): `/babysit` → `/babysit-triage`.
- **`~/docs/babysitters/performance/README.md`** (line 26) and **`charter.md`** (lines 4, 86): `/babysit performance` → `/babysit-triage performance`.
- **`~/docs/arthack-claude-plugin-inventory.md`** (lines 46, 167): the command leaves arthack — update the `/arthack:babysit-new` row to `keeper:babysit-init`, drop `babysit-new.md` from the arthack file-layout line, and add a `keeper:babysit-triage` row (never previously inventoried).
- **keeper `README.md`** (~L2347 closed-loop note): OPTIONAL — both scouts confirmed there is no existing `/babysit` slash-command string here (the refs are scanner/watchdog). A one-line fold-in pointing at `/babysit-triage <slug>` is a nicety, not a gate.

## Best practices

- **Filename stem = command name** for `commands/*.md`; rename the file, not just `name:`. [official docs]
- **Preserve `disable-model-invocation: true`** — these are human-only triage commands; dropping it makes them model-invocable and defeats the safety gate. [official docs]
- **No runtime cross-reference link-checker** — a missed old-name reference fails silently; the grep sweep is the only guard. [practice-scout]
