## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl, .../cli-conventions/boundary-lint.md.tmpl, .../engineering/tmp-file-unique-path.md.tmpl, claude/CLAUDE.md, claude/arthack/CLAUDE.md, apps/cli_common/CLAUDE.md, apps/cli_common/cli_common/commit_attribution.py, buildbot master.cfg, system/tests/test_buildbot_notify.py, scripts/lint-skill-prefixes.sh, scripts/install.sh

### Approach

Retire planctl in arthack. CORRECTNESS FIX: `keeper-history-forensics.md.tmpl` documents `planctl_op`/`planctl_epic_id`/`planctl_task_id` sqlite columns — those were renamed to `plan_*` at keeper v78, so the snippet currently gives humans a BROKEN query; update to `plan_*`. Rename the buildbot BUILDER named `planctl` → `keeper-plan` (or `plan`) in master.cfg + flip `test_buildbot_notify.py` assertions (watch the builder-name-as-string trap; check anything that references the builder id). Update the snippet/CLAUDE prose (boundary-lint `planctl→keeper` subprocess exemption — verify the actual SUBPROCESS_EXEMPTIONS key; tmp-file `mktemp -t planctl-scaffold` example → neutral name; claude/CLAUDE.md + apps/cli_common/CLAUDE.md one-liners). Add a `planctl:` skill-prefix BAN to `lint-skill-prefixes.sh` + a one-time `install.sh` cleanup, reusing the proven `ln`-retirement template. BOUNDARY: `commit_attribution.py` + `test_git_trailers.py` — if they parse the literal `Planctl-Op` trailer, that literal is a cross-repo FROZEN read-spot; keep the literal, rename only incidental naming.

### Investigation targets

**Required:**
- claude/arthack/template/_partials/snippets/engineering/keeper-history-forensics.md.tmpl (the now-wrong column query)
- apps/cli_common/cli_common/commit_attribution.py + tests/test_git_trailers.py (trailer-literal boundary)
- the buildbot master.cfg builder def + system/tests/test_buildbot_notify.py
- scripts/lint-skill-prefixes.sh + scripts/install.sh (the `ln` ban+cleanup template to mirror)

### Risks

- Buildbot builder rename: if branch-protection / notification config references the builder by string, update those too.
- Keep the literal `Planctl-Op` trailer if commit_attribution.py parses it.

### Test notes

`uv run python -m pytest` for the buildbot + commit_attribution tests; arthack lint matrix via keeper commit-work.

## Acceptance

- [ ] keeper-history-forensics snippet query fixed to plan_* columns
- [ ] buildbot builder renamed + test_buildbot_notify assertions flipped + any builder-id references updated
- [ ] arthack prose/snippets swept; `planctl:` skill-prefix ban + install.sh cleanup added (ln template)
- [ ] trailer-literal read-spots preserved; arthack tests + lint green

## Done summary
Retired the planctl name across arthack: fixed the broken keeper-history-forensics snippet query (planctl_* event columns renamed to plan_* at keeper v78), renamed the buildbot notify test builder fixture to keeper-plan, swept incidental commit_attribution symbols to plan_* (preserving the frozen Planctl-Op trailer literal), emptied the dead planctl->keeper SUBPROCESS_EXEMPTIONS entry, and cleaned residual prose. Repo-wide grep now returns only the frozen Planctl-Op trailer literals plus the sanctioned ln-template ban/cleanup scripts.
## Evidence
