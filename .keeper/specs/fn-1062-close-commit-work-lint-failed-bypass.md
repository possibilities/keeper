## Overview

Census evidence (gitpolice sitter, ~/babysitters/gitpolice/rounds/1782962263.md cluster D):
8 sessions in 2 days hit a commit-work `lint_failed` envelope and bare-git
add+commit+push'd instead of retrying, while 4 followed the documented recovery
(fix → `git add` restage → re-invoke → success). The projection scoped correctly every
time; the escape is behavioral — the standing bare-git escape-hatch advice reads as
permission after one lint failure. Close it with two coordinated changes: (1) the
`lint_failed` envelope carries its own recovery contract at the agent's decision point;
(2) every copy of the escape-hatch advice is scoped to genuine staging-coverage gaps
with an explicit lint carve-out. End state: a lint failure always loops
(fix → restage → re-invoke), never bails to bare git; the gitpolice census
(commit-work-fallback findings + sanctioned ratio) is the re-measurement instrument.

Scope fence: NO commit-work scoping/attribution changes (attribution.ts, file
discovery untouched). stderr secret-scrubbing considered and DEFERRED (separate
concern, existing field).

### Canonical carve-out wording (pin — mirror verbatim, do not re-phrase per copy)

Full form (worker.md.tmpl, hack/SKILL.md, plugins/plan/README.md, arthack snippet):

> **A lint failure is never a coverage gap.** When the commit-work envelope reports
> `"error": "lint_failed"`, this fallback does not apply — the only permitted recovery
> is: fix the reported lint errors, re-stage with `git add`, and re-invoke
> `keeper commit-work` with the same message. Never bare `git commit` or `--no-verify`
> after a lint failure.

Terse form (plugins/plan/skills/plan/SKILL.md inline bullet):

> (does not apply to `lint_failed` — fix lint, re-stage, re-invoke instead)

Envelope `recovery` string (static constant, exact text):

> Fix the reported lint errors in the files listed, re-stage them with `git add
> <files>`, then re-invoke `keeper commit-work` with the same message. Do NOT fall
> back to bare `git commit` or use `--no-verify` — a lint failure is not a coverage gap.

## Quick commands

- cd ~/code/keeper && bun test test/commit-work.test.ts
- keeper prompt render bundle/engineering | grep -A3 "lint failure"  # rendered standing advice carries the carve-out
- rg -l "temporary escape hatch" plugins/ ~/code/arthack/claude/arthack/template/_partials/snippets/engineering/ # every copy updated

## Acceptance

- [ ] lint_failed envelope carries the pinned `recovery` string; compact single-line invariant holds; existing fields unchanged (additive only)
- [ ] All five verified escape-hatch copies carry the pinned carve-out (arthack canonical snippet; worker.md.tmpl + 4 regenerated worker.md; hack/SKILL.md; plugins/plan/README.md; plan/SKILL.md terse form); keeper root README confirmed out of scope (no copy exists)
- [ ] The four generated worker.md files updated via `keeper prompt render-plugin-templates`, never hand-edited; generated-guard oracle fixture refreshed if needed
- [ ] Envelope-example prose blocks (worker.md.tmpl, hack/SKILL.md, arthack snippet, lint-matrix.ts doc-comment) show the new shape verbatim as landed
- [ ] work/SKILL.md lint_failed BLOCKED-exception language verified consistent (no structural change expected)
- [ ] bun test green in keeper; prompt oracle tests green

## Early proof point

Task that proves the approach: `.1`. If the compact/byte-parity envelope constraint
fights the added field, fall back to a shorter single-sentence recovery string —
never a structured object (no consumer branches on structure).

## References

- Census evidence: ~/babysitters/gitpolice/rounds/1782962263.md (cluster D: 8 bypass
  sessions; cluster B: the 4 correct recovery loops)
- Envelope build site: cli/commit-work.ts:585-592; serializer :115-136; fail sink :399-403
- Canonical snippet (arthack): claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl (+ _index.yaml:992-1013)
- Generated-file guard: plugins/prompt/src/check_generated.ts + test/oracle/fixtures/check-generated.json

## Docs gaps

- **plugins/plan/skills/work/SKILL.md (~192,207)**: verify-only — lint_failed
  inline-handle exception language must stay consistent with the new worker prose
- **keeper root README.md**: no escape-hatch copy exists (121 lines) — confirmed out
  of scope, listed here to prevent re-discovery

## Best practices

- **Recovery guidance lives in the error payload:** the tool result is injected at
  the agent's decision point — closer than any system prompt; mirror the prohibition
  in both places (two shots at the same model state)
- **One primary path + one explicit prohibition:** a menu of alternatives teaches the
  agent the wrong paths are legitimate; keep recovery prose ≤3 sentences
- **Conditional scoping beats blanket bans:** the "does not apply when
  `error=lint_failed`" pattern outperforms bare prohibition; key the carve-out off the
  TRUSTED tool-response field, never an agent's self-assessed "lint failed" (OWASP LLM06)
- **Additive schema evolution:** optional field, never remove/retype existing fields,
  never make `recovery` required
