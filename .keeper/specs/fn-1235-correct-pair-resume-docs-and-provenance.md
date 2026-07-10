## Overview

Two text-accuracy cleanups on the just-landed pair-resume surface, neither
changing runtime behavior. The pair SKILL.md overstates the `--resume`
capture guard (claims it rejects `--session` and that `--name` should be
passed on every launch, but the resume-capture path silently drops both),
and two brand-new modules carry a bare `fn-1232` fn-id in their doc-comments
against CLAUDE.md rule #0. Both are documentation/comment hygiene fixes that
land as one small commit.

## Acceptance

- [ ] SKILL.md's `--resume` documentation matches the actual reject/thread behavior
- [ ] No fn-id appears in the resume-policy code comments (ADR pointer retained)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Verified doc-vs-code drift: SKILL.md:284-285 lists `--session` in the `--resume` Rejects set and says pass `--name` on every launch, but runResumeCaptureSubcommand (main.ts:1456-1466 rejects only model/effort/preset; posture `{}` at :1557) neither rejects nor threads `--session`/`--name`. |
| F2 | kept | .1 | Verified CLAUDE.md rule #0 violation: resume-policy.ts:2 and agent-resume-policy.test.ts:2 open doc-comments with bare fn-id `epic fn-1232`; drop the fn-id, keep the sanctioned ADR 0034 pointer. |

## Out of scope

- Any change to the resume-capture runtime behavior itself (dropping `--session`/`--name` on resume is deliberate — the resumed session keeps its own config; the fix is documentation-only).
