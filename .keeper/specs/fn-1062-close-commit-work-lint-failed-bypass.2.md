## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl (arthack repo)

### Approach

The canonical `keeper prompt` snippet `commit-via-keeper-default` is the source of
the standing bare-git escape-hatch advice every agent renders — it lives in the
ARTHACK repo, so a keeper-only change leaves the rendered advice unfixed. Apply the
pinned FULL carve-out wording from the epic spec ("Canonical carve-out wording" —
mirror VERBATIM, do not re-phrase) to the escape-hatch paragraph, and update the
snippet's lint_failed envelope example to the exact literal shape landed by task .1
(transcribe field order from the shipped envelope, including the `recovery` field).
Keep the existing "temporary escape hatch we'll repair" framing and the
staging-coverage-gap scoping already present; the change ADDS the lint carve-out and
the recovery field, pruning any now-redundant recovery prose per the docs-prune
discipline. Check whether the snippet's _index.yaml entry (description text) needs
no change — expected no; do not restructure the index.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl — the canonical snippet (envelope example ~:26, escape hatch ~:32)
- ~/code/keeper/cli/commit-work.ts lint_failed emit site — the landed envelope shape to transcribe (post task .1)
- The epic spec's pinned wording section — the verbatim carve-out text

**Optional** (reference as needed):
- ~/code/arthack/claude/arthack/template/_partials/snippets/_index.yaml:992-1013 — the snippet's index entry (verify-only)
- ~/code/keeper/plugins/prompt/test/oracle/ — render tests, only if snippet content is fixture-covered

### Risks

- Verbatim-mirror discipline: a re-phrased carve-out here diverges from the five
  keeper-side copies and reopens ambiguity. Copy the pinned text exactly.
- The rendered advice is what agents actually read (`keeper prompt render`) —
  verify the render after editing, not just the file.

### Test notes

`keeper prompt render bundle/engineering | grep -B2 -A4 "never a coverage gap"`
shows the carve-out in the rendered output; `keeper prompt find-snippets
"commit-work"` still resolves the snippet; run the keeper prompt-plugin oracle
tests if snippet content is fixture-covered.

## Acceptance

- [ ] Canonical snippet carries the pinned full carve-out verbatim + the landed envelope shape (incl. recovery, exact field order)
- [ ] Rendered output (`keeper prompt render`) shows the carve-out; snippet still resolves in find-snippets
- [ ] _index.yaml untouched or minimally consistent; committed in the arthack repo

## Done summary
Applied the pinned lint_failed carve-out to the canonical commit-via-keeper-default arthack snippet: envelope example gained the recovery field and the escape hatch now carries the verbatim 'never a coverage gap' prohibition. Refreshed the keeper render oracle golden to match.
## Evidence
