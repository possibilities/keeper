## Description

**Size:** M
**Files:** CLAUDE.md, README.md

### Approach

Strip root `CLAUDE.md` from 547 to ~80–100 lines by the keep/cut test: a
line stays only if it is imperative ("Never X"), an agent would plausibly
get it wrong, getting it wrong is costly (corruption / fail-closed session /
security), AND it is not discoverable in the code/test the agent is already
reading. When unsure whether a line is a real gotcha or narration, KEEP the
rule and drop the rationale. Lift the docs-prune rule from
`plugins/plan/template/agents/worker.md.tmpl:212` verbatim to the TOP of
CLAUDE.md as rule #0, naming `scripts/lint-claude-md.ts` so it is actionable
on first read. Relocate the architecture/rationale prose — the 159-line
`## Event-sourcing invariants` section, the Autopilot / bus / process
narration, and every fn-/version/date-tagged "how it works" paragraph — into
README `## Architecture` (README.md:1552-3404), matching its flat
**bold-lead-in** paragraph register and COLLAPSING duplicates rather than
appending. Drive every `fn-\d+` / lowercase `v\d{2,}` / ISO-date /
past-tense-provenance token out of CLAUDE.md so the new lint is green.
Update the 4 README back-references that point at moved/renamed CLAUDE.md
sections (README.md:296, 676, 1749, 3401-3402) to resolve.

**Definite KEEPERS** (preserve as terse imperatives, rationale stripped):
AGENTS.md-symlink-edit-in-place; two plugins / one manifest each / never add
a `~/.claude/plugins/keeper` symlink; all four hooks exit 0; no
`bun:sqlite`/`db.ts` in a hook; the five-RPC-write-surface scope; plans are
read-only; no kernel watchers on keeper's own DB; no in-process self-heal
(`fatalExit`); cursor+projection advance in one `BEGIN IMMEDIATE`; never
throw in a fold; re-fold determinism (no clock/env/fs reads in a fold);
forward-only migrations + bump `SUPPORTED_SCHEMA_VERSIONS` in the same
commit; `isMainThread` worker guard + own read-only `openDb`; `sandboxEnv`
covering the six state classes; two test tiers + `test:full` before
daemon/worker/db/hook changes; no real git in default tiers; forward-facing
advice only.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md — the full strip target. Section map: Repo facts 16-79 (mixed), Event-sourcing 80-238 (worst offender, mostly narration), Hook rules 239-294, Migrations 295-312 (keep rules), Writes-scoped 313-335 (keep), Process/DB-watch 336-370, Worker contract 371-416, Test isolation 417-487 (keep rules), Autopilot 488-544 (narration)
- README.md:1552 — `## Architecture` start; the flat bold-lead-in register to match, and confirm it already carries fn-/version (do not repoint the lint at it)
- plugins/plan/template/agents/worker.md.tmpl:212 — the prune rule to lift verbatim (does NOT quote the banned phrases — safe)
- README.md:296, 676, 1749, 3401-3402 — the back-references to update

**Optional** (reference as needed):
- plugins/plan/CLAUDE.md:5 — the banned-phrase precedent vocabulary
- scripts/lint-claude-md.ts — the gate this must satisfy; run it against the result

### Risks

- Cutting a genuine guardrail is the main hazard — preserve every definite-keeper; this task warrants a human review pass on the keep/cut split.
- The relocation must not duplicate prose already in `## Architecture`.
- This commit stages CLAUDE.md, so once task .1 has landed `keeper commit-work` gates it — the file must be lint-green at commit time.

### Test notes

No unit tests; verification is `scripts/lint-claude-md.ts` exiting 0 on the
result, a manual read confirming the definite-keepers survive as imperatives,
and the README back-references resolving.

## Acceptance

- [ ] CLAUDE.md is <=120 lines and <=16KB (aim 80–100), every surviving line an imperative guardrail passing the keep/cut test
- [ ] all definite-keeper rules preserved (enumerated in Approach)
- [ ] the docs-prune rule sits at the TOP as rule #0, naming `scripts/lint-claude-md.ts`
- [ ] zero `fn-\d+` / lowercase `v\d{2,}` / ISO-date / past-tense-provenance tokens remain in CLAUDE.md (`scripts/lint-claude-md.ts` exits 0)
- [ ] relocated architecture/rationale prose lands in README `## Architecture` in the bold-lead-in register with no duplicated paragraphs
- [ ] README back-references at 296, 676, 1749, 3401-3402 updated to resolve (no dangling CLAUDE.md section pointers)
- [ ] the `AGENTS.md` symlink is untouched (edited in place, never recreated)

## Done summary
Stripped root CLAUDE.md from 577 to 119 imperative-only guardrails (lint-green, docs-prune as rule #0), relocated codex-trust prose to README ## Architecture, and repointed the dangling README back-references.
## Evidence
