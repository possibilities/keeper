## Description

**Size:** M
**Files:** src/usage-scrape/scrape.ts, src/usage-scrape/scrape-cli.ts, src/usage-scrape/parse-claude-usage.ts, src/usage-scrape/parse-codex-status.ts, src/usage-scrape/reset-time.ts, src/usage-scrape/parse-bridge.ts, package.json, test/usage-scrape-parse-claude.test.ts, test/usage-scrape-parse-codex.test.ts, test/usage-scrape-reset-time.test.ts, test/usage-scrape-scrape.test.ts, test/usage-scrape-cli.test.ts, test/usage-scrape-conformance.test.ts, test/helpers/conformance-derive.ts, test/fixtures/corpus/

### Approach

Move the six scraper modules from `~/code/agentusage/src/` into a new
`src/usage-scrape/` subtree as first-class keeper code, and take custody of
their six in-process test suites plus the conformance corpus (`tests/fixtures/corpus`,
~244K) and its `conformance-derive.ts` helper. Adapt, don't transliterate:
module headers and comments go forward-facing (keeper house voice — state the
seam and its invariants; drop all port/provenance narration referencing the
Python implementation, pexpect/pyte, or the source repo's ADR numbering) while
RETAINING the load-bearing rationale as present-tense invariants — in
particular the claude-reprojects-to-system-zone vs codex-keeps-offset
reset-time semantics that guard envelope compatibility. Converge the tmux
BINARY resolution on the shared `resolveTmuxBin(env)` helper; the codex
command resolution stays as-is. The socket name `agentusage-scrape`, the
`/tmp/agentusage-scrape-` tmpdir prefix, and the `agentusage-scrape.tmux.conf`
name are pinned byte-identical (the consumer worker's path filter keys on that
token). Add `@js-temporal/polyfill` to package.json exact-pinned `0.5.1`
(house style for runtime deps). No module in the subtree may import
`src/db.ts` or `bun:sqlite`. Migrated suites keep their in-process discipline
(canned tmux probes, zero subprocess spawns) and land on the fast tier with a
`usage-scrape-` name prefix; the corpus goes under `test/fixtures/corpus/`
byte-identical, and the conformance suite's >=14-case count guard proves the
repointed corpus path resolves.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- ~/code/agentusage/src/*.ts — the six source modules; scrape.ts:403,425 (bare tmux invocations to converge), scrape.ts:286-296 (codex resolution — keep as-is), scrape.ts:73 (socket), scrape.ts:796 (tmpdir prefix)
- src/agent/tmux-launch.ts:702 — resolveTmuxBin(env), the shared resolver to converge on
- src/usage-scrape-runner.ts:1-35 and cli/usage.ts:1-33 — keeper module-header house voice
- ~/code/agentusage/tests/conformance-derive.ts — relative imports to repoint (`../src/...` → the merged paths)
- ~/code/agentusage/src/parse-conformance.test.ts — CORPUS_DIR resolution + the >=14 CASES guard

**Optional** (reference as needed):
- scripts/assert-comment-only.ts, scripts/lint-claude-md.ts — the comment/doc gates the rewrite must pass
- test/helpers/retry-until.ts — mandated poll helper if any migrated assertion waits

### Risks

- Toolchain drift: source was written under biome 2.5 / tsc 6; keeper runs biome 2.2 / tsc 5 — TS6-only syntax or rule drift surfaces at lint/typecheck.
- Comment rewrite dropping load-bearing timezone/lift rationale — the "why" behind reset-time semantics must survive as present-tense invariants.

### Test notes

`bun test` green including all migrated suites; the conformance suite is the
parser-drift gate going forward (the standalone corpus runner stays behind in
the archive). Suites must stay fast-tier pure — no real tmux, no subprocess,
no sandbox classes needed beyond a tmpdir.

## Acceptance

- [ ] The six scraper modules live under keeper source, compile and lint clean under keeper's toolchain, and none of them import keeper's DB module or bun:sqlite
- [ ] The scrape CLI entry runs standalone via bun and exits non-zero with usage text when required args are missing
- [ ] tmux binary resolution goes through the shared resolver while the dedicated socket name, tmpdir prefix, and tmux conf name remain byte-identical
- [ ] All migrated suites pass on the fast tier, including the conformance suite proving at least 14 corpus cases against the migrated fixture tree
- [ ] Module comments state current behavior only — no external-project, Python-port, or foreign-ADR references — while the reset-time timezone invariants remain documented
- [ ] The Temporal polyfill is exact-pinned in package.json

## Done summary
Moved the six usage-scraper modules + their in-process suites and the 14-case conformance corpus into src/usage-scrape/ and test/ as first-class keeper source; converged tmux resolution on resolveTmuxBin, exact-pinned @js-temporal/polyfill 0.5.1, dropped external-project/Python/ADR comment provenance while retaining reset-time timezone invariants, and renamed the internal --agentwrap-profile token off the retired name. Full fast suite + typecheck + lint green.
## Evidence
