## Overview

Thread anti-bloat doc/comment discipline into every prompt surface that shapes worker and planner behavior, so agents stop writing provenance comments, parity-narration blocks, and append-only CLAUDE.md edits. This epic is the valve for the multi-repo comment-squeegee mission — squeegee epics in keeper/planctl/arthack/vtkeep will depend on it.

## Canonical discipline block

The exact rules every task echoes (adapt voice per surface, never the substance):

- **Default to no comments.** Write one only when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround, behavior that would surprise a reader. If deleting it wouldn't confuse a future reader, don't write it.
- **Never provenance or narration.** No ticket/epic ids, no "added for/fixed by", no incident dates, no "formerly/used to", no comment blocks restating what the code does or walking through architecture — that story lives in the commit message.
- **Prune on touch.** Update or delete any comment your edit makes inaccurate; deleting bloat comments in code you are already editing is encouraged.
- **Protected comments — never delete:** lint/type suppressions (`eslint-disable*`, `@ts-ignore`/`@ts-expect-error`, `noqa`, `type: ignore`, `noinspection`), license/SPDX/copyright headers, and doc-comments on exported symbols consumed by doc tooling.
- **Docs prune, never append-only.** Doc edits consolidate and delete as readily as they add; CLAUDE.md gains a line only for a rule an agent would otherwise get wrong.

## Quick commands

- `grep -A12 'Doc & comment discipline' agents/worker-high.md` — block present in a rendered worker
- `cd ~/code/arthack && promptctl render bundle/engineering-rules | grep -i 'code comment'` — snippet rides the bundle

## Acceptance

- [ ] All four rendered worker agents carry the discipline block; sidecar sha256s fresh (check-generated guard passes)
- [ ] Plan skill 5e/5g no longer produce ticket-id constraints or default doc-update acceptance items; Docs gaps supports prune/delete entries
- [ ] Close cycle exerts negative pressure: quality-auditor flags comment/doc bloat; close-planner culls without comment-consolation
- [ ] `code-comment-style` snippet exists in arthack and is listed in the engineering-rules bundle
- [ ] No prompt surface gained backward-facing or ticket-id prose from these edits

## Early proof point

Task that proves the approach: ordinal 1 (template edit + re-render round-trip through the deny-hook machinery). If it fails: edit stays template-only and we debug `promptctl render-plugin-templates` against planctl's root before other tasks land.

## References

- Canonical comment-rule formulation source: Claude Code production system prompt ("default no comments / WHY-only / no provenance")
- Rule-count ceiling: keep each agent's discipline block at <=5 bullets; placement at section start/end, never mid-prompt
- planctl CLAUDE.md "Doc & comment style" (no backward-facing advice) — every edit here must obey it

## Docs gaps

- **AGENTS.md**: consolidate its "Doc & comment style" block — state canon once, cross-reference the worker template (task 1)
- **README.md** agent table: one-line posture updates for quality-auditor / docs-gap-scout only if visibly changed (task 3)

## Best practices

- **Protected-comment allowlist co-located with every prune instruction:** prevents workers stripping functional suppressions/licenses
- **Single-source the canon:** all surfaces echo this epic's block; never fork divergent wordings
