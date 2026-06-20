## Overview

The keeper plan-family skills emit unwanted trailing content at the end of flows (especially `/hack` → `/plan`): offers to run `/plan:work`, await-arming prompts raised every flow, read-only inspection menus, and "the human's call" followup framing. Since keeper autopilot dispatches AND closes all plan work end-to-end, the agent should be left in the dark about execution and go quiet at the edges. This epic makes the wrap-ups silent by default — forward-facing prose edits to the plan-family skill markdown (plus the work template and one doc), no code or contract changes.

## Quick commands

- `cd /Users/mike/code/keeper/plugins/plan && bun test`  # consistency-skills + consistency-generated-guard must pass
- `grep -rn "plan:work" plugins/plan/skills/*/SKILL.md`   # only mechanism descriptions remain, no human-facing offers

## Acceptance

- [ ] No human-facing wrap-up in any plan-family skill offers `/plan:work`; mechanism descriptions are left untouched.
- [ ] The hack skill's post-plan advice is silence-by-default for awaits, plus a new always-on "close-signal" that speaks only when nothing is left.
- [ ] `/plan:next` is recommended only in the defer context.
- [ ] No trailing read-only verb menu in `plan/SKILL.md` Phase 8; no manual-followup framing in work/close.
- [ ] `plugins/plan/CLAUDE.md` "Skills and agents" is synced to the new routing; all plan-plugin consistency tests pass.

## Early proof point

Task that proves the approach: `.1` (the whole change lands as one commit). If the work-template re-render fails the `consistency-generated-guard` test: re-edit `work.md.tmpl` and re-run `promptctl render-plugin-templates` until the sidecar sha matches and the guard passes — never hand-edit the rendered `work/SKILL.md`.

## References

- **`work/SKILL.md` is GENERATED** from `plugins/plan/template/skills/work.md.tmpl`; the rendered file is sha-pinned by `plugins/plan/skills/work/SKILL.md.managed-file-dont-edit` and guarded by `plugins/plan/test/consistency-generated-guard.test.ts`. Edit the template, then re-render via `promptctl render-plugin-templates`.
- **Forward-facing-advice-only** doc/comment style is documented in `CLAUDE.md`, `plugins/plan/CLAUDE.md` (`## Doc & comment style`), and baked into `hack/SKILL.md:199-204` (cites `promptctl render code-comment-style`). Deleted offers/menus must leave no tombstone — state the present rule only.
- **Distinguish offers from mechanism descriptions** — `plan/SKILL.md:372` (the worker agent `/plan:work` spawns) and `work.md.tmpl:130,167` (internal resume re-runs) mention `/plan:work` but are NOT human-facing offers; leave them.
- **`hack/SKILL.md` is hand-authored static** (no `.tmpl`, no managed sidecar) — edit in place.
- Inter-epic: epic-scout found NO dependency/overlap with the open board (fn-863/864/865 are dispatch-CLI + rename work, disjoint from skill prose).

## Docs gaps

- **`plugins/plan/CLAUDE.md` "Skills and agents" (~:32-34)**: update the `/plan:hack` routing posture and `/plan:next` scope to match the new behavior (close-signal, defer-only `/plan:next`). Revise in place, forward-facing, no new paragraph.
- **`README.md` await section (~:1138-1197) / `keeper:await` reference**: verify whether any prose conflates the `keeper await` CLI binary with the skill's silence-by-default posture; trim only if it makes a skill-behavior claim. Likely CLI-only — verify, probably no change.
