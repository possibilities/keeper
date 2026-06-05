## Description

**Size:** M
**Files:** cli/commit-work.ts, src/commit-work/lint-matrix.ts (new), src/commit-work/push.ts (new), test/commit-work.test.ts (new)

### Approach

Fill the keystone verb, porting `run_commit_work.py` run() (~826 lines)
to TS with byte-parity to the Python envelopes. Pipeline: resolve session-id
(fail with `{success:false,error:"no session id available"}` + exit 1, never
silent no-op) → attribution discover (task 1) → gitignore filter
(`git check-ignore -z --stdin`, fail-open ≥128) → `--max-files` guard on the
POST-filter count (default 500, 0 disables; same guard governs
`--preview-files`) → acquire flock → `git add -A -- <explicit pathspecs>`
(the `-A` is pathspec-scoped — stages session deletions as removals; NOT
tree-wide) → unstage-stale (`all_staged − caller_files`) BEFORE lint so the
matrix sees only caller files → lint matrix → sanitize message +
`_FORBIDDEN_TRAILER_RE` gate (fires only when message is multi-line; full
regex `Job-Id:|Session-Id:|Signed-off-by:|Planctl-*:`) → `git commit -F -`
with appended `Job-Id:` trailer → NDJSON line 1 (COMPACT single-line
`{success,commit_sha,files}`) → push → NDJSON line 2 (compact push envelope)
→ release flock. Lint matrix (`src/commit-work/lint-matrix.ts`): port
`_run_scoped_lint` — concurrent (Promise.all) external linters, cwd-discovered
(ruff/uvx ty/scripts/lint-cli-boundaries.py per `.py`; npm-lint per nearest
lint-capable package.json; shellcheck/ziglint+zlint/hadolint per suffix) PLUS
a NEW dedicated `tsc --noEmit --project <tsconfig>` arm fired when any
`.ts/.tsx` is staged (pin `--project` so it cannot false-pass on missing
tsconfig). Exit-code is the sole pass/fail; aggregate single failure as
`linter=<name>`, multiple as `linter="multiple"` with labelled `--- <linter>
---` stderr blocks + union files; emit `{success:false,error:"lint_failed",
linter,files,stderr}`. Push (`src/commit-work/push.ts`): `git push
--no-progress`; no-upstream is `git rev-parse @{u}` exit 128 → `git push -u
origin HEAD`; classify push errors into the 6 byte-exact stderr-substring
classes (`non_fast_forward`/`hook_rejected`/`auth`/`network`/`no_upstream`/
`other`). Lock release must mirror the Python finally (set fd sentinel to
avoid double-release on the lint-fail path).

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/jobctl/jobctl/run_commit_work.py — full run(), _run_scoped_lint:206-405, _sanitize_message+_FORBIDDEN_TRAILER_RE, _git_stage:445, _git_commit_staged:527, _classify_push_error:559, _git_push:643, two-line NDJSON envelope:695-826
- ~/code/arthack/apps/jobctl/jobctl/cli.py — flag surface (--max-files 500, --preview-files, message arg)
- ~/code/arthack/apps/cli_common/cli_common/formatting.py:182 — json_dumps shape (compact vs indent=2 per callsite)

**Optional** (reference as needed):
- ~/code/arthack/apps/cli_common/cli_common/session_context.py:66 — current_job_id sources (env-only in TS)

### Risks

- NDJSON byte-shape: commit-work uses COMPACT `print(json.dumps())` two lines; readers use pretty indent=2. planctl + line-oriented consumers depend on the compact form — match exactly.
- tsc false-pass if `--project` unpinned; biome ignores positional args (keeper's own `npm run lint` = `biome check cli src test`) — account for keeper-self-commit scoping.
- Push-error class substrings are a consumer contract (worker dispatch keys on them) — replicate byte-for-byte; `auth`/`network` lowercase the stderr before matching.
- Lock double-release / leak on the lint-fail branch.

### Test notes

Temp git repo + sandboxed KEEPER_DB + seeded file_attributions rows; assert
preview file list, the lint_failed envelope on an injected ruff failure, the
two-line compact NDJSON on success (mock push or local bare remote), the
no-upstream exit-128 path, and that a session deletion stages as a removal.

## Acceptance

- [ ] Stage→lint→commit→push pipeline matches the Python envelopes byte-for-byte (compact two-line NDJSON).
- [ ] New `tsc --noEmit --project` arm runs when `.ts` staged and cannot false-pass; all existing linter arms preserved, exit-code-driven, stderr verbatim.
- [ ] `--max-files`/`--preview-files`/forbidden-trailer/no-upstream-128/push-classification all parity with Python.
- [ ] flock acquired before staging, released on every exit path (incl lint-fail) without double-release.
- [ ] `pnpm test` covers preview, lint_failed, success, no-upstream, deletion-staging.

## Done summary

## Evidence
