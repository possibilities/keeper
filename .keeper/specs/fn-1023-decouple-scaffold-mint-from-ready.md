## Overview

Today `keeper plan scaffold` stamps `last_validated_at` inline on mint, which
satisfies autopilot readiness predicate 2 (`epic-not-validated`) immediately —
so a freshly-scaffolded epic's dep-free tasks fold to `[ready]` in the window
before Phase 6 `epic add-deps` wires its cross-epic deps, and an unpaused/yolo
autopilot can dispatch them out of dependency order. This change decouples
"minted" from "ready": `scaffold` mints an epic with `last_validated_at: null`
(a not-ready "ghost", blocked by predicate 2, rendered dashed by dashctl/watch),
and the "ready" signal is deferred to an explicit `validate --epic` arm that the
create (`/plan:plan`), defer (`/plan:defer`), and close (`/plan:close`
close-finalize) flows run only after all deps are wired. Reuses the existing
nullable marker + `validate --epic` — no new verb, no new phase column.

## Quick commands

- `d=$(mktemp -d); (cd "$d" && git init -q && keeper plan init >/dev/null && keeper plan scaffold --file - <<'Y'
  epic: {title: smoke}
  tasks: [{title: t, tier: medium, deps: [], spec: "## Description\n## Acceptance\n- [ ] x\n## Done summary\n## Evidence"}]
  Y
  )` — then `jq .last_validated_at "$d"/.keeper/epics/*.json` must print `null` (ghost on mint).
- `keeper plan validate --epic <id>` in that dir, then re-check `jq .last_validated_at` → now a microsecond timestamp (armed).
- `bun test` (from `plugins/plan/`) stays green with the flipped scaffold-marker assertions.

## Acceptance

- [ ] `scaffold` mints `last_validated_at: null`; the pre-write integrity gate is unchanged (malformed trees still rejected atomically, no writes land).
- [ ] `/plan:plan`, `/plan:defer`, and `/plan:close` all leave their minted epic **armed** (non-null marker) once deps are wired — no flow births a permanent ghost.
- [ ] close-finalize arms the follow-up at the `closed_with_followup` chokepoint (fresh-scaffold AND both adopt paths), excludes `partial_followup`, and an arm failure never corrupts the terminal envelope nor hard-exits after the irreversible epic close.
- [ ] `bun test` green (both real-git tiers where relevant); no stale scaffold-stamps-inline claim survives in code, help strings, or docs.

## Early proof point

Single task proves the whole approach. If it fails: revert the one-line
`scaffold.ts` mint change (`null` → `nowIso()`) to restore current behavior
instantly; every other edit (the arm calls, docs, tests) is inert without it.

## References

- Autopilot readiness gate — `src/readiness.ts:8-48` (predicate 2 `epic-not-validated` blocks + renders ghost; predicate 9 `dep-on-epic`). Read-only consumer; no daemon edit.
- Daemon folds committed HEAD only — `src/plan-worker.ts:766-770`. Why an uncommitted stamp after `commit_failed` is invisible to autopilot until the next `.keeper/` commit sweeps it.
- Rejected alternative: a dedicated `phase` enum column (`SCAFFOLDED|ARMED|…`) instead of reusing the nullable marker. Cleaner in the abstract but a larger redesign touching every marker consumer; deliberately not taken.

## Docs gaps

- **`plugins/plan/CLAUDE.md`** "Validation marker" section: both halves invert (scaffold no longer stamps on mint; `validate --epic` is now the trailing arm on create AND close). Prune the scaffold "mints via its own path, never the restamp helper" non-member note; fix the pre-existing "14 verbs" → 11 count while there.
- **`plugins/plan/skills/plan/SKILL.md`**: Phase 5 (~345) drop the "stamps inline → Phase 7 skipped" claim; Phase 7 (~596-608) now runs on the create path (unconditional `validate --epic` after Phase 6), keeping the existing ghost language.
- **`plugins/plan/skills/defer/SKILL.md`**: add the arm step; update the "only mutating verb is scaffold" guardrail + Phase 5 report.
- **`plugins/plan/skills/close/SKILL.md`**: note that close-finalize arms the follow-up (or that the arm lives inside close-finalize) — keep "no saga logic in the skill" honest.
- **`plugins/plan/README.md`** (~144): reword the `validate` envelope "never been validated before" framing now that validate runs routinely post-scaffold.

## Best practices

- **Idempotent arm is load-bearing:** `validate --epic` is a null→timestamp no-op when already stamped, which is what makes arming safe at the close-finalize chokepoint (adopt paths may re-arm an already-armed epic) and makes the create-path unconditional arm a safe no-op after `add-deps` already restamped. Don't add any "only arm if null" caller-side guard — rely on the verb's own short-circuit.
