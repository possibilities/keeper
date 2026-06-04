# Classifier verdict contract

Reference for the `classifier` agent used by `/plan:close`. The agent's behavioral
instructions live in its definition (`apps/planctl/agents/classifier.md`); the closer
constructs the per-invocation message inline (Phase 4 of `apps/planctl/skills/close/SKILL.md`)
by interpolating `EPIC_ID`, `PRIMARY_REPO`, and the auditor report. This file is the canonical
reference for the verdict contract — sentinel choice, tier semantics, and finding shape — that
the agent prose, the closer's parser, and `schema.json` must agree on.

## Sentinel Choice: `<VERDICT_JSON>`

The verdict block uses the sentinel `<VERDICT_JSON>` (not bare `<verdict>`). Rationale: the classifier's own prose frequently discusses "the verdict" and tier outcomes, creating false-trigger risk with a short sentinel. `<VERDICT_JSON>` is long enough to be unique and unambiguous in classifier output.

The parser (Phase 5 of `/plan:close`) uses a non-greedy regex with DOTALL and last-match-wins:

```python
import re
matches = re.findall(
    r"<VERDICT_JSON>(.*?)</VERDICT_JSON>",
    classifier_output,
    re.DOTALL,
)
raw_json = matches[-1].strip() if matches else None
```

Last-match-wins defends against the "thinking preview" risk where sonnet emits an incomplete or example block mid-prose before producing the final block.

The classifier system prompt explicitly forbids `<VERDICT_JSON>` from appearing in prose. The parser's last-match-wins behavior is a defense-in-depth layer — the primary mitigation is the prompt instruction.

## Classifier Stance

The classifier opens as **an impartial expert advisor**, not a "helpful reviewer." It holds ground on judgement calls. It does not flag findings to be helpful. The bar is high: flag only what has real user impact. **Leaving code alone is the default.** This directive opens the classifier system prompt (`agents/classifier.md`) so it frames every tier judgement that follows.

## Tier Semantics

| Tier | Meaning | Closer action |
|------|---------|---------------|
| `fatal` (bool) | Show-stopper for real users in production | Halt, do NOT close (no status stamp) |
| `tier_0` | Ignored / advisory / theoretical / style | No action; the closer does not vet these |
| `tier_1` | High-priority candidate; localized user-visible impact | Vetted inline by the closer (Phase 6.2); survivors scaffold a follow-up epic |
| `tier_2` | Scoped followup candidate; non-trivial user-visible improvement | Vetted inline by the closer (Phase 6.2); survivors scaffold a follow-up epic |
| `tier_3` | Large cross-cutting followup candidate | Vetted inline by the closer (Phase 6.2); survivors scaffold a follow-up epic |

`fatal` is orthogonal to the tier arrays. A verdict can have `fatal: true` AND non-empty tier arrays — the tier arrays document findings regardless of the fatal flag, but the closer halts on fatal regardless of what's in the tier arrays.

### `fatal` definition (load-bearing)

Set `fatal: true` ONLY when shipping this epic as-is would cause a show-stopper for real users in production. The bar is: would a real user notice this and reasonably stop using the feature?

Triggers: data loss, security breach, correctness defect that makes the feature unusable as shipped, or a regression that breaks the happy-path flow.

**NOT fatal:** tolerable defects (works most of the time, edge case fails non-destructively), non-show-stopper user impact (rough edges, minor UX gaps), theoretical issues, code-quality concerns, or behavior gaps that don't break the spec's happy path.

When in doubt, NOT fatal — route to `tier_1` / `tier_2` / `tier_3` and let the closer's inline audit pass plan the followup.

## Filtering Discipline

If you can leave the code alone, leave it alone. Adding a code comment is a valid alternative to flagging. You will see this code again on the next touch — issues don't have to be caught now.

NEVER flag a finding unless ONE of these holds:

1. It has real, concrete user impact ("would a user notice this if it shipped?").
2. It's a behavior gap or correctness defect that breaks the spec's happy path.
3. It would surprise the next person to read the code.

Theoretical issues, style preferences, minor optimizations, naming nitpicks, and "this could be cleaner" go in `tier_0` — ignored. Reserve `tier_1` / `tier_2` / `tier_3` for issues with concrete user impact or behavioral correctness.

This same discipline is restated in the classifier system prompt (`agents/classifier.md`); keep the two in sync when either changes.

## Multi-Repo Discipline

Prefer paths within `primary_repo` when possible — the closer's inline audit plans tasks against the source repo by default. Findings touching files outside `primary_repo` are still valid (escalate to `tier_2` / `tier_3` so the audit pass can scope the cross-repo work properly), but a finding that's localizable to `primary_repo` should be tiered there. Soft guidance, not a hard rule.

## Verdict JSON Schema

The schema lives at `apps/planctl/skills/close/classifier/schema.json`. It is JSON Schema Draft 2020-12 with:

- `additionalProperties: false` at both top-level and Finding level
- `minLength: 1` on all string fields (top-level `fatal_reason` allows empty string when `fatal: false`)
- All top-level fields required: `fatal`, `fatal_reason`, `tier_0`, `tier_1`, `tier_2`, `tier_3`
- All Finding fields required: `id`, `title`, `summary`, `rationale`, `severity_reason`, `affected_paths`, `evidence`, `suggested_fix`

The closer validates the extracted JSON with `jsonschema.Draft202012Validator` and uses `jsonschema.exceptions.best_match()` to surface actionable error messages. A schema validation failure is treated the same as a parse failure: halt, do NOT close (no status stamp).

## Finding ID Stability

Finding ids (`F1`, `F2`, ... or short slugs) appear in the closer's `## Audit decisions` table on the follow-up epic — they're the durable provenance link from the audit's `Source` column back to a specific classifier finding. Keep them stable across classifier re-runs so a re-audit can correlate verdicts cleanly. Do not use sequential integers that shift when findings are added/removed — prefer slugs for ambiguous cases.

## Message the closer constructs

```
EPIC_ID: <epic_id>
PRIMARY_REPO: <absolute_path>

--- AUDITOR REPORT ---
<verbatim quality-auditor output>
--- END AUDITOR REPORT ---
```

The closer passes this as the user message to the classifier agent (optionally prefixed with a `## Snippet context` section when the epic carries bundle context). The classifier's system prompt (in `apps/planctl/agents/classifier.md`) provides all behavioral instructions.
