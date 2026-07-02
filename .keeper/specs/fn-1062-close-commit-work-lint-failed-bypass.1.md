## Description

**Size:** M
**Files:** cli/commit-work.ts, src/commit-work/lint-matrix.ts, test/commit-work.test.ts, plugins/plan/template/agents/worker.md.tmpl, plugins/plan/workers/opus-{medium,high,xhigh,max}/agents/worker.md (regenerated), plugins/plan/skills/hack/SKILL.md, plugins/plan/README.md, plugins/plan/skills/plan/SKILL.md

### Approach

**(1) Envelope.** At the lint_failed emit site (cli/commit-work.ts:585-592) add one
static `recovery` string field with the EXACT text pinned in the epic spec
("Canonical carve-out wording" section). Static constant at the envelope build —
no interpolation (the failing files already ride the `files` field; the text reads
correctly for the `linter: "multiple"` aggregated case and the empty-files case).
Reuse the existing fail/printCompact sink — no new emission path. Additive only:
existing fields keep their names, types, and insertion order. Update the envelope
doc-comment at src/commit-work/lint-matrix.ts:51-52 to the new shape. Extend the
lint-failure test (test/commit-work.test.ts:653-679) to assert `recovery` is present
and non-empty AND that the compact single-line invariant (:674-675, no raw newline)
still holds — the recovery text must serialize with escaped newlines or contain none.

**(2) Keeper-side prose.** Apply the pinned FULL carve-out wording (epic spec) to:
plugins/plan/template/agents/worker.md.tmpl (escape-hatch block ~:149; also fold the
new `recovery` field into the envelope example at ~:145 and :230, trimming now-
redundant surrounding prose per the docs-prune rule); plugins/plan/skills/hack/
SKILL.md (:257 envelope example, :263 escape hatch); plugins/plan/README.md (:126).
Apply the pinned TERSE form to plugins/plan/skills/plan/SKILL.md (:337 inline
bullet). Verify (no structural change expected) plugins/plan/skills/work/SKILL.md
:192,207 lint_failed BLOCKED-exception language stays consistent.

**(3) Regenerate, never hand-edit.** The four opus-*/agents/worker.md are generated
from worker.md.tmpl and write-blocked by the managed-file guard
(plugins/prompt/src/check_generated.ts). After editing the template run
`keeper prompt render-plugin-templates --project-root <keeper root>` and commit the
four regenerated copies; refresh plugins/prompt/test/oracle/fixtures/
check-generated.json only if the oracle covers this template's content.

### Investigation targets

**Required** (read before coding):
- cli/commit-work.ts:585-592 — the lint_failed build+emit site
- cli/commit-work.ts:115-147, 399-403 — pyCompact/printCompact byte-parity serializer + fail sink; header :24-30 documents the compact contract
- src/commit-work/lint-matrix.ts:51-68 — LintFailure fields + the doc-comment restating the envelope shape
- test/commit-work.test.ts:653-679 — the lint-failure envelope test (CommitWorkDeps seams, runLint throw pattern, single-line assertion)
- plugins/plan/template/agents/worker.md.tmpl:145,149,230 — envelope example + escape-hatch block in the ONE editable source of the four worker docs
- plugins/prompt/src/check_generated.ts — the generated-file guard you must not fight

**Optional** (reference as needed):
- plugins/plan/skills/hack/SKILL.md:257,263; plugins/plan/README.md:126; plugins/plan/skills/plan/SKILL.md:337; plugins/plan/skills/work/SKILL.md:192,207
- cli/commit-work.ts:412-433 — CommitWorkDeps test seams

### Risks

- The compact/byte-parity contract: a multi-sentence recovery string must not break
  the single-line envelope (JSON-escaped newlines are fine; verify the serializer
  never emits raw newlines). If it fights, shorten the string — never restructure.
- Missing a prose copy reopens the bypass; the keeper-side inventory is exactly the
  files listed above (root README verified to carry NO copy — do not add one).
- Do not touch src/commit-work/attribution.ts or file discovery (scope fence).

### Test notes

bun test test/commit-work.test.ts (envelope assertions incl. recovery + single-line);
full bun test; prompt oracle tests if the fixture was refreshed. Grep-verify every
keeper-side copy carries the pinned wording verbatim:
`rg -c "never a coverage gap" plugins/` should hit worker.md.tmpl, the 4 generated
worker.md, hack/SKILL.md, plugins/plan/README.md.

## Acceptance

- [ ] lint_failed envelope carries the pinned static `recovery` string; all pre-existing fields byte-identical in name/type/order; compact single-line test extended and green
- [ ] lint-matrix.ts doc-comment matches the landed shape
- [ ] worker.md.tmpl edited + 4 worker.md regenerated via render-plugin-templates (guard respected); hack/SKILL.md, plugins/plan/README.md updated with the pinned full form; plan/SKILL.md with the pinned terse form
- [ ] work/SKILL.md consistency verified (note in Done summary)
- [ ] full bun test green

## Done summary

## Evidence
