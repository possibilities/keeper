## Description

**Size:** S
**Files:** plugin/bin/git, test/git-wrapper.test.ts

### Approach

Drop a `git` shell-script wrapper into `plugin/bin/git` (already first in keeper's PATH, currently a non-existent reserved slot). The wrapper detects whether the invocation is `git commit` by walking past leading git global options (`-c KEY=VAL`, `-C path`, `-p`, `--paginate`, `--no-pager`, `--git-dir=...`, `--work-tree=...`, `--namespace=...`, `--bare`, `--no-replace-objects`, `--literal-pathspecs`, etc.) to find the real subcommand. When the subcommand is `commit` AND `$CLAUDE_CODE_SESSION_ID` is set, inject `--trailer "Session-Id: $CLAUDE_CODE_SESSION_ID"` after the `commit` token before `exec`ing `/usr/bin/git`. Every other path-through is byte-identical argv to real git. Git's `--trailer` defaults to `addIfDifferentNeighbor` so amend with the same session-id is a no-op (verified empirically in conversation).

### Investigation targets

**Required:**
- `/Users/mike/code/arthack/apps/jobctl/jobctl/run_commit_work.py:43` — `subprocess.run(["git", ...])` confirms jobctl uses PATH-resolved git, so wrapper intercepts transparently
- empirical session verification (already done): `CLAUDE_CODE_SESSION_ID` is natively in the Bash tool env on Claude Code 2.x; PATH position of `plugin/bin/` is 34 (first among /Users/mike paths); a test wrapper stamped + extracted the trailer cleanly and `commit --amend` didn't duplicate

**Optional:**
- `/Users/mike/code/arthack/system/arthack/.local/bin/arthack-claude.py:2283-2303` — env whitelist; shell-snapshot mechanism for context

### Risks

- Wrapper failure (exec error, malformed args, missing /usr/bin/git) breaks every git invocation in the session. Mitigation: tiny bash script, exhaustive subcommand-detection tests, the only failure mode is "couldn't determine subcmd → fall through to real git unmodified" (conservative default).
- `git rebase --continue`, cherry-pick internals, and `git merge` call libgit code directly without PATH lookup — those commits land trailer-less and global-discharge. Intentional: history rewrites shouldn't carry original session-id forward.
- Compound shell (`cd foo && git commit ...`): wrapper sees only its own argv, doesn't matter; the cwd at exec time is what `git commit` sees.

### Test notes

`test/git-wrapper.test.ts` via `bun:test` using `Bun.spawnSync` against `plugin/bin/git` in a tmp git repo. Cover at minimum: `git commit -m x`, `git -c K=V commit -m x`, `git -C path commit -m x`, `git --no-pager commit -m x`, `git commit --amend --no-edit` (verify no trailer duplication), and negative cases (`git status`, `git log`, `git push`) — must NOT inject anything. Cleanup via `mkdtempSync` + `rmSync({recursive: true})`.

## Acceptance

- [ ] `plugin/bin/git` exists, is `chmod +x`, and is a self-contained bash script (no external deps beyond `/usr/bin/git`, `/bin/bash`)
- [ ] Wrapper detects `commit` as subcommand under common global-option prefixes (`-c K=V`, `-C path`, `--no-pager`, `-p`, `--paginate`)
- [ ] Injects `--trailer "Session-Id: $CLAUDE_CODE_SESSION_ID"` after the `commit` token only when env is set; trailer-extraction via `git log -1 --format='%(trailers:key=Session-Id,valueonly,only,unfold)'` round-trips
- [ ] Non-commit invocations pass through unmodified (verified by comparing exit code + stdout against direct `/usr/bin/git` invocation for a sample of subcommands)
- [ ] `git commit --amend --no-edit` with same session-id does NOT duplicate the trailer
- [ ] `test/git-wrapper.test.ts` passes with ≥6 subcommand-detection cases + amend dedup
- [ ] Manual verification: `jobctl commit-work --preview-files` and `jobctl commit-work "test"` invocations route through the wrapper (jobctl uses bare `["git", ...]` per investigation)

## Done summary
Added plugin/bin/git wrapper (bash, +x) that walks past git global options to detect  subcommand and injects --trailer "Session-Id: $CLAUDE_CODE_SESSION_ID" before exec'ing /usr/bin/git. 13-case bun:test suite covers commit/amend/global-option/pass-through paths.
## Evidence
