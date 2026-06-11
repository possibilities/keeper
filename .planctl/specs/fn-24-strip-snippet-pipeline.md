## Overview

Finish what fn-13 started: remove the snippet-substrate pipeline (validation, sketch-ref inlining, attach verbs, delivery diagnostics, authoring ceremony) from planctl and arthack while preserving the content library, the deterministic delivery channels, and the dormant brief seam for a future context-delivery system. End state: no pipeline verbs, no sketch-ref inlining, no bundle-health watch, no sketch-command snippet ceremony — and the snippet library still renders through Jinja includes, runtime bundles, and `promptctl render` pointers.

## Quick commands

- `cd ~/code/planctl && uv run pytest tests/ -q` — planctl suite green post-strip
- `promptctl render commit-via-keeper-default >/dev/null && echo library-ok` — kept library renders
- `promptctl bundle-health 2>&1 | grep -qi "no such command" && echo verb-gone` — pipeline verbs removed
- `launchctl list | grep arthack.promptctl.bundle-health-snapshot; test $? -ne 0 && echo agent-gone`

## Acceptance

- [ ] planctl: sketch_refs.py, bundle_ref.py, the 4 set-snippets/set-bundles verbs, and the scaffold/refine-apply validation + sketch-inline blocks are gone; scaffold and refine-apply still persist `snippets:`/`bundles:` YAML keys verbatim (pass-through, unvalidated — the dormant seam's go-forward contract)
- [ ] Dormant seam intact: models.py snippets/bundles defaults, brief.py snippet_context present-and-empty (schema_version 1), test_models dormant-field tests green plus a round-trip test loading a record with non-empty dormant lists
- [ ] promptctl: render-spec, bundle-health, bundle-health-snapshot, inline-sketch-refs gone from cli.py and api.py; render's --session-id no-op flag untouched; seen-stubs left to fn-663
- [ ] LaunchAgent booted out before plist deletion; no orphan in launchctl list
- [ ] Sketch command carries no snippet ceremony; sketch.md and hack.md re-rendered from templates; 4 orphan snippets deleted; the rest of the library and bundles untouched
- [ ] No backward-facing prose introduced; planctl CLAUDE.md "Removed verbs" guardrail appended
- [ ] Both repos: lint, typecheck, and full test suites green

## Early proof point

Task that proves the approach: ordinal 1 (planctl core strip — the run_scaffold.py/run_refine_apply.py surgery is the riskiest edit; persistence must survive the inline-block deletion). If it fails: stop, investigate the variable threading at run_scaffold.py:1010-1013 and 1170/1213, and refine the task with the exact re-threading before retrying.

## References

- planctl commit b68d432 ("refactor(brief): quiet the snippet-substrate render surface") + epic fn-13-snip-snippet-substrate-surface — the Phase-1 predecessor this epic completes
- `fn-663` (overlap) — fn-663.2 deletes promptctl seen-stubs (show-seen-snippets/clear-seen) and their --session-id flags from the same cli.py/api.py surface; stub deletion belongs to fn-663, not this epic; render's --session-id no-op stays per fn-622
- `fn-664` (overlap) — fn-664.1 edits arthack CLAUDE.md Pointers and re-renders hack/sketch from the snippet template; same files as this epic's pointer cleanup and template strip
- Session investigation 2026-06-11: funnel coverage 1-3% of specs, 88/92 snippets remain reachable via surviving channels (Jinja includes, bundles, render pointers)

## Docs gaps

- **arthack CLAUDE.md (root)**: delete the "Bundle-health watch" Pointers bullet
- **arthack claude/CLAUDE.md**: prune the bundle-health/snapshot clause from the promptctl plugin entry
- **arthack claude/arthack/CLAUDE.md**: reword "ships /sketch for the runtime snippet substrate" — /sketch survives without the substrate
- **arthack system/CLAUDE.md**: replace the bundle-health plist example with a still-live plist name
- **planctl skills/plan/SKILL.md**: Phase 1a --bundle wire-format routing becomes dead — delete; Phase 4 "plan sketch" parenthetical describing the --bundle re-entry — delete
- **planctl CLAUDE.md**: append the 4 set-verbs + scaffold --snippets/--bundles flags to "Removed verbs (do not re-add)"; drop real_sketch from the slow-bucket marker list

## Best practices

- **Same-commit lockstep:** feature-only tests, autouse fixtures, and pytest marker registrations must die in the same commit as the modules they import — --strict-markers turns a stale marker into a suite-wide collection failure
- **Dormant fields outlive writers:** keep Pydantic declarations with default_factory=list / default="" and add a permanent round-trip test with non-empty dormant lists; no validators on dormant fields
- **bootout before rm:** launchctl bootout gui/$(id -u)/<label>, then delete the plist, then verify absence via launchctl list
- **Leaf-before-root:** strip importers' references before deleting bundle_ref.py/sketch_refs.py so the type checker confirms no dangling refs at each step
