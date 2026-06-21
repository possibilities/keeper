## Overview

Closer-generated follow-up epics can be scaffolded with the wrong per-task `target_repo`, sending autopilot workers into the wrong git tree — a SILENT misdispatch (no error). For a cross-repo source epic (state repo != the repo some code lives in), the close-planner's follow-up YAML omits `target_repo`, and scaffold defaults each task to `primary_repo`. This epic fixes it in two layers: the close-planner emits an explicit per-task `target_repo` (authoring), and the engine refuses to silently default one for a multi-repo source (fail-loud backstop). End state: a follow-up over a multi-repo source either carries a correct, in-set `target_repo` per task or fails the close re-runnably — never a silent wrong-tree dispatch.

## Quick commands

- `cd /Users/mike/code/keeper && PLANCTL_RUN_SLOW=1 bun test plugins/plan/test/saga-scaffold.test.ts plugins/plan/test/saga-close-finalize.test.ts` — the close/scaffold saga incl. the new multi-repo guard
- `cd /Users/mike/code/keeper && bun test plugins/plan/test/src-scaffold-dryrun.test.ts` — dry-run `taskTargetRepos` collection

## Acceptance

- [ ] The close-phase brief carries per-task `target_repo` and epic `touched_repos`; the close-planner emits an explicit `target_repo` per follow-up task.
- [ ] A follow-up over a MULTI-repo source with a missing OR out-of-set per-task `target_repo` is rejected (`repo_required`) at both the `followup submit` dry-run and the scaffold mint seam, re-runnably (source epic stays open).
- [ ] A SINGLE-repo source close is unchanged — no reject, the existing default-to-primary behavior is preserved on the common path.

## Early proof point

Task that proves the approach: `.2` (the engine guard) with the `saga-scaffold` multi-repo reject test. If it fails: the predicate/normalizer is the suspect — verify the source `touched_repos` superset test compares realpath-normalized paths on both sides.

## References

- Incident: source epic `fn-688-port-promptctl-into-keeper-prompt` (primary_repo=arthack, touched_repos=[arthack,keeper]) minted follow-up `fn-689-fix-keeper-prompt-cli-arg-parsing-and` whose tasks defaulted to arthack while the code lives in keeper; hand-patched, this epic is the systematic fix.
- Worker cwd resolution: `plugins/plan/src/runtime_status.ts:11-21` (task.target_repo -> epic.primary_repo -> proj).

## Docs gaps

- **plugins/plan/README.md**: update the close-phase brief-shape sentence (~:69) to name `target_repo` as a per-task field the brief carries (alongside id/title/status/done_summary).

## Best practices

- **Gate on ambiguity, not absence:** the guard fires only when the source is multi-repo AND a `target_repo` is missing — a single-repo source has a deterministic answer, so it must never reject. Keeps the guard off the 99% path.
- **Engine validates, never resolves:** the engine checks presence + membership (`target_repo` in source `touched_repos`); it never picks a repo. Judgment stays in the close-planner (LLM) layer.
- **"state repo" != "code repo":** never treat `primary_repo` as a routing key — `target_repo` is a separate field with a separate lifecycle.
