## Description

Originating finding F1 (refine_context.ts:70-79). The `if (!resolution.ok)`
block special-cases only `resolution.reason === "ambiguous"` and then falls
through to `emitRefineError("EPIC_NOT_FOUND", "Epic not found: ...")`, so the
`no_project` outcome from `tryResolveOwningProjectForId` is rendered as a
misleading "Epic not found" on a `--project` path with no `.keeper/`. The
`resolveOwningProjectForId` wrapper used by done/show — and cat — render
`no_project` correctly; only this bespoke branch drops it.

Add a `resolution.reason === "no_project"` branch emitting the
project-missing message (matching the sibling verbs' wording, e.g.
"No planctl project found at <path>. Run 'planctl init' first.") through
refine-context's typed `{code,message}` envelope. Keep the fail-closed
exit-1 behavior.

Folds in TG1: add a test asserting the `no_project` path for refine-context
(the gap that would have caught F1). Name BOTH F1 and TG1 in the work — the
fix (F1) and its regression test (TG1) land as one commit.

## Acceptance

- [ ] refine-context with `--project <path-without-.keeper>` emits the project-missing message via its typed envelope, not "Epic not found".
- [ ] A regression test exercises the `no_project` reason through refine-context and asserts the new message + exit 1.
- [ ] Existing refine-context not-found / ambiguous behavior is unchanged.

## Done summary

## Evidence
