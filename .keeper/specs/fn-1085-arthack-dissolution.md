## Overview

Cut the load-bearing wires between keeper and the arthack checkout so a fresh machine runs the
full autopilot loop with zero arthack present, and workers stop inheriting arthack entirely.
Grounded in the dissolution study (~/docs/arthack-dissolution-study.md): workers today run
permission_mode=default with zero bypass — 147K worker tool events were silently carried by
arthack's blanket auto-approve hook; keeper never owned its worker permission posture. The
corpus and default plugins.yaml edges already landed; this epic owns the remainder. Settled
decisions: skip-permissions flavor for workers; the isolation gate ships config-flagged OFF and
is flipped ON for this machine at epic end.

## Quick commands

- Launch a worker with arthack's scan dirs removed from a scratch config: it runs tools without stalling on permission prompts
- Fresh clone with no arthack checkout: install → `keeper agent claude --help` → autopilot work→close round-trip

## Acceptance

- [ ] Worker launches carry keeper-owned permission posture (skip-permissions + acceptEdits); no worker behavior depends on arthack's auto-approve
- [ ] Every render workers/skills reach resolves inside the vendored corpus subset (no arthack checkout required)
- [ ] Config-flagged worker isolation gate exists at the discovery seam, composition-test-pinned in both states; flipped ON for this machine at epic end
- [ ] Clean-machine proof documented and passing; docs describe arthack as an optional plugin

## Early proof point

Task `.1` — one argv branch + test; immediately severs the biggest dependency. If
skip-permissions proves wrong in practice (unexpected prompt classes), fall back to a
keeper-owned agent_id-gated auto-approve hook.

## References

- ~/docs/arthack-dissolution-study.md — inventory, verdict matrix (§4), end-state design (§5); observed-usage grounding §2
- src/exec-backend.ts buildKeeperAgentLaunchArgv worker branch (study anchor :879-908) — the permission edit site; pair-path precedent in launch-config
- src/agent/main.ts:2194-2228 — the sole plugin-discovery seam (gate site); src/exec-backend.ts:899-900 additive per-cell --plugin-dir
- plugins/prompt/corpus/ + vendor.lock (landed) — the vendored subset; KEEPER_PROMPT_CORPUS_ROOT config fallback (plugins/prompt/src/project_root.ts)
- docs/plugin-composition-map.md + its standing test — must be extended, not contradicted
- Deny-via-envelope hooks (branch-guard et al) enforce regardless of permission mode — the guardrail story under skip-permissions

## Docs gaps

- **README.md / docs/plugin-composition-map.md**: worker permission posture + gate states; arthack-as-optional-plugin story
- **CLAUDE.md**: only if the gate creates a rule agents would otherwise get wrong (lint-gated, minimal)
