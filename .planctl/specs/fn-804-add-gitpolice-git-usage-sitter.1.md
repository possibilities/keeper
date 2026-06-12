## Description

**Size:** M
**Files:** lib/git-detect.ts (new), lib/schema-pin.ts (new), performance/watch.ts, test/git-detect.test.ts (new), test/watch.test.ts

### Approach

Two dep-free lib modules. (1) `lib/git-detect.ts`: vendor keeper's
quote/backslash-aware `tokenizeShell` (keeper src/derivers.ts:644 — COPY,
never import; the build-pin fence enforces this) and EXTEND it to walk
ALL simple commands across unquoted `;`, `|`, `&` separators instead of
stopping at the first. Strip leading env-assignment tokens
(ENV_PREFIX_RE `/^[A-Z_][A-Z0-9_]*=/`) and a leading `env [-flags]
[VAR=val ...]` prefix to find the effective argv[0]; honor
BASH_COMMAND_CAP (32_000 — skip outsized commands). Export
`detectInvocations(command: string): Invocation[]` returning one entry
per command-position `git` invocation (`{argv, subcommand, class}`) and
per `keeper commit-work` invocation (`{argv, kind: 'commit-work'}`).
Classification: strip git global flags (`-C <dir>`, `-c k=v`,
`--no-pager`, `--git-dir=…`, `--work-tree=…`) before reading the
subcommand; classify via an explicit table into `read | mutate |
commit`. Sub-subcommand-aware entries: bare `stash`/`stash
push/pop/apply/drop/branch` mutate while `stash list/show` read;
`checkout`/`switch`/`restore` always mutate; `reflog` reads but `reflog
expire/delete` mutate; `notes`/`remote`/`branch`/`tag` split by
sub-subcommand; `commit/push/merge/rebase/pull/cherry-pick/am/revert`
are `commit`; unknown subcommands default to `mutate` (conservative —
a false page beats a silent miss). Redact URL userinfo
(`scheme://user:pass@` → `scheme://[redacted]@`) in a
`redactCommand(command)` helper the census will apply before persisting.
Everything degrade-don't-throw: a pathological command returns `[]`,
never raises. (2) `lib/schema-pin.ts`: hoist `SUPPORTED_SCHEMA_VERSIONS`
(performance/watch.ts:362-374), `detectSchemaSkew` (:472-521), and
`readSchemaVersion` (:1606-1623) — moved verbatim, semantics unchanged;
performance/watch.ts re-exports or imports them so its existing tests
and any external readers stay green.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/src/derivers.ts:644 — tokenizeShell to vendor (quoting subset, separator handling)
- /Users/mike/code/keeper/src/derivers.ts:488-498 — BASH_COMMAND_CAP + ENV_PREFIX_RE
- performance/watch.ts:362-374, 472-521, 1606-1623 — the three hoist targets
- test/watch.test.ts:746-798, 1857-1914, 1952 — detectSchemaSkew tests + scan-level skew tests + the membership pin (must stay green against the hoisted import)

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/derivers.ts:843+ — extractBashMutation (the git-tree-mutate set keeper already uses)
- https://github.com/git/git/blob/master/command-list.txt — classification ground truth

### Risks

- Tokenizer extension subtly changes first-segment behavior — keep the vendored single-segment function recognizable and test parity against keeper's known cases.
- Classification table disagreements bite later; the table is data (one map), so corrections are one-line edits. Conservative default (unknown → mutate) bounds the damage to false pages.

### Test notes

test/git-detect.test.ts: table-driven over real-world command strings —
compound commands (`git add -A && git commit -m x && git push`), command
position negatives (`echo git status`, `GIT_SSH_COMMAND=ssh git push`
counts once not twice, `hub --vcs git`), env/env-prefix forms
(`GIT_AUTHOR_NAME=x git commit`, `env git log`), global-flag stripping
(`git -C /tmp stash list` → read), stash/checkout/reflog/notes/remote
sub-subcommand splits, `keeper commit-work --preview-files` detection,
redaction, cap/degrade paths. Schema-pin hoist: existing skew tests
relocated or re-imported, membership pin (SUPPORTED_SCHEMA_VERSIONS has
FIXTURE_SCHEMA_VERSION) intact.

## Acceptance

- [ ] `detectInvocations` finds git invocations across all `;|&`-joined segments, only in command position, with correct read/mutate/commit classes for the trap cases (bare stash, stash list, checkout, reflog expire, -C-prefixed)
- [ ] `keeper commit-work` invocations detected with full argv preserved
- [ ] `redactCommand` scrubs URL userinfo; pathological inputs return [] without throwing
- [ ] SUPPORTED_SCHEMA_VERSIONS + detectSchemaSkew + readSchemaVersion live in lib/, imported by performance/watch.ts; all existing tests green; zero keeper imports (build-pin fence passes)

## Done summary
Added lib/git-detect.ts (quote-aware tokenizer extended across all ;|& segments; detectInvocations classifies command-position git + keeper commit-work; redactCommand scrubs URL userinfo; degrades to [] never throws) and hoisted SUPPORTED_SCHEMA_VERSIONS + detectSchemaSkew + readSchemaVersion (plus the shared fingerprint substrate) into lib/schema-pin.ts so both sitters gate on one pin; performance/watch.ts re-exports them. All tests green, zero keeper imports.
## Evidence
