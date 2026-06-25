## Description

**Size:** M
**Files:** test/server-worker.test.ts, test/bus-worker.integration.test.ts, test/integration.test.ts, test/control-rpc.test.ts, test/*.slow.test.ts (13 files), scripts/test-real-git-allowlist.txt, scripts/lint-no-real-git.ts, package.json

### Approach

`git rm` the dedicated real-infra test files: `server-worker.test.ts` (160
Worker+socket tests), `bus-worker.integration.test.ts`, `integration.test.ts`,
`control-rpc.test.ts` (stands up a real `Bun.listen` UDS echo server in
beforeEach), and ALL 13 `test/*.slow.test.ts`. Delete
`scripts/test-real-git-allowlist.txt` and `scripts/lint-no-real-git.ts`, and
remove the `test:hygiene` script from package.json. Do NOT collapse the
`test` path-ignore list here — that is the finalize task; leave the entries
(they become no-ops pointing at deleted files). FIRST verify `bun test`
tolerates a `--path-ignore-patterns` glob matching no file (no run-failing
error); if it errors, remove each deleted file's entry in lockstep here.

### Investigation targets

**Required** (read before coding):
- scripts/lint-no-real-git.ts — what `test:hygiene` runs (the whole thing is deleted)
- scripts/test-real-git-allowlist.txt — note it also lists NON-slow real-git files (commit-work-foundation, integration, plan-contract, plan-worker) handled by task .3
- package.json — the `test` / `test:full` / `test:hygiene` scripts

**Optional** (reference as needed):
- test/control-rpc.test.ts — confirm the UDS server is the whole fixture (whole-file cut) vs has pure parts worth keeping

### Risks

`bun` erroring (not tolerating) a non-matching path-ignore glob would force the
path-ignore removal into this task too. control-rpc.test.ts may have a few pure
assertions worth preserving — judge before a whole-file cut.

### Test notes

After deletion, `bun test` (current fast tier) runs green; `bun run test:full`
runs green (until task .5 collapses it).

## Acceptance

- [ ] server-worker, bus-worker.integration, integration, control-rpc, and all 13 *.slow.test.ts deleted
- [ ] test-real-git-allowlist.txt and lint-no-real-git.ts deleted; test:hygiene removed from package.json
- [ ] `bun test` runs green with the (now no-op) path-ignore entries still present

## Done summary

## Evidence
