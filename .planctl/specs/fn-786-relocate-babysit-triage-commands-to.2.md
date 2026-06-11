## Description

**Size:** S
**Files:** claude/arthack/template/commands/babysit.md.tmpl (delete), claude/arthack/template/commands/babysit-new.md.tmpl (delete), claude/arthack/commands/babysit.md (auto-pruned), claude/arthack/commands/babysit-new.md (auto-pruned), claude/arthack/template/_partials/snippets/_index.yaml (auto-regenerated)

### Approach

Land AFTER task .1 so the commands always have a live source. Delete the two
arthack templates and re-render once — the render verb self-cleans everything
downstream — then verify the diff is exactly the expected prune set and nothing
else moved.

1. `rm ~/code/arthack/claude/arthack/template/commands/babysit.md.tmpl ~/code/arthack/claude/arthack/template/commands/babysit-new.md.tmpl`.
2. `promptctl render-plugin-templates --project-root ~/code/arthack`. This single call: (a) runs `build-snippets` internally (run_render_plugin_templates.py:644-650), regenerating `_partials/snippets/_index.yaml` so the `commit-via-keeper-default` snippet's `used-in:` list drops `babysit.md.tmpl` (the snippet itself survives — hack.md.tmpl + sketch.md.tmpl still use it); (b) runs commands-only orphan-cleanup, unlinking the now-sourceless `claude/arthack/commands/{babysit,babysit-new}.md` and their `.managed-file-dont-edit` sidecars. No manual `rm` of generated files, no separate `build-snippets` call.
3. Verify the resulting `git status` shows EXACTLY: 2 deleted `.tmpl`, 2 deleted `commands/babysit*.md`, 2 deleted `*.managed-file-dont-edit` sidecars, and 1 modified `_index.yaml` (only the babysit `used-in:` line removed). `hack.md` / `sketch.md` and their sidecars must be UNTOUCHED — if they show in the diff, the render over-reached; stop and investigate.
4. Cross-repo grep sweep (the rename's only link-check): `git -C ~/code/arthack grep -nE 'babysit-new|/babysit[^-]'` and `git -C ~/code/keeper grep -nE 'babysit-new|/babysit[^-]'`, EXCLUDING archival `.planctl/specs/fn-7*` and any `.jsonl` transcripts. Expect zero live hits to the old names. (Settings allowlists already verified clean — no `Skill(babysit...)` entries anywhere.)
5. Stage only this task's paths; commit via `keeper commit-work` from `~/code/arthack`.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/promptctl/promptctl/run_render_plugin_templates.py:571-680 — `_prune_command_orphans` + the internal `build-snippets` call; confirms one render call cleans both the orphaned outputs/sidecars and the snippet index
- ~/code/arthack/claude/arthack/template/_partials/snippets/_index.yaml:~1083 — the babysit `used-in:` entry that should disappear after re-render

**Optional:**
- ~/code/arthack/claude/arthack/commands/ — confirm hack.md / sketch.md remain after the prune (dir survives, non-babysit outputs untouched)

### Risks

- Running the render from the wrong `--project-root` (or omitting it) could prune the wrong tree or no-op. Always pass `--project-root ~/code/arthack`.
- If the render touches hack/sketch outputs, something regressed in the render config — do not commit a broad diff; investigate first.
- `~/docs/arthack-claude-plugin-inventory.md` also references the arthack command — that's task .3's surface, not this one; don't edit `~/docs` here.

### Test notes

- `git -C ~/code/arthack status --porcelain` lists only the 6 expected file changes + the 1 `_index.yaml` modify.
- The cross-repo grep returns no live old-name references.

## Acceptance

- [ ] Both `.md.tmpl` templates deleted; `promptctl render-plugin-templates --project-root ~/code/arthack` run once
- [ ] Rendered `commands/babysit*.md` + their `.managed-file-dont-edit` sidecars are pruned; `_index.yaml` no longer lists `babysit.md.tmpl` under the snippet's `used-in:`
- [ ] `hack.md` / `sketch.md` and their sidecars are unchanged (no render over-reach)
- [ ] Cross-repo grep sweep (excluding archival specs + transcripts) shows no live reference to the old command names
- [ ] Committed via `keeper commit-work` from `~/code/arthack`

## Done summary
Deleted the two arthack babysit command templates and re-rendered, pruning the orphaned command outputs/sidecars and the snippet used-in entry. Cross-repo grep confirms no live old-name references remain (archival specs untouched).
## Evidence
