## Overview

keeper's agent-facing skill surface gains standing board supervision (`keeper:watch`), a read-plane reference (`keeper:query`), and orchestration advice in the hack/plan planning surfaces — research epics, deliberate worker check-ins, and ask-first pilot etiquette. All prose riding existing daemon machinery: no daemon/CLI/src code, no vendored-corpus changes.

## Quick commands

- `bun scripts/vendor-corpus.ts --check` — bake/POINTER drift gate over the edited skills
- `bun test test/lint-skill-ids.test.ts` — the naming lint the two new skill dirs must pass
- `keeper query tasks --json | head -c 400` — the read surface the new skills document, live

## Acceptance

- [ ] keeper:watch and keeper:query load as model-invocable keeper skills following house conventions (frontmatter, POINTER-only, NOT-for boundaries)
- [ ] hack and plan surfaces teach research epics (complete-gated, named retrieval path), blocked-as-collaboration (with the TOOLING_FAILURE and creator-edge caveats), and ask-first piloting — all reference-shaped
- [ ] Full gates green: `bun run test:full` plus the vendored-corpus drift check; hack keeps exactly six byte-identical BAKE guards
- [ ] No changes outside the five prose files (two new skill files + three edited)

## Early proof point

Task that proves the approach: ordinal 1 (keeper:query). It exercises the whole authoring contract end-to-end — skill auto-discovery, the naming lint, and POINTER refs resolving against the vendored index. If it fails: re-read the skill-id lint and the vendored `_index.yaml` rows and adjust the convention assumptions before authoring watch.

## References

- `docs/skill-authoring.md` — governing authoring method (predictability-first, leading words, description tokens pay permanent context load)
- `plugins/plan/skills/plan/references/operator-orchestration.md` — single-source home of the blocked-agent protocol and multi-epic topologies
- `plugins/keeper/skills/{autopilot,dispatch,debug,await}/SKILL.md` — house conventions and the sections the new skills borrow by reference
- `CLAUDE.md` §Autopilot — sticky taxonomy and escalation-sequencing invariants the watch triage ladder must respect
- Resolved decisions (human-approved): skill names keeper:watch / keeper:query; research-artifact default `~/docs/<slug>.md`; prose-only, no vendored snippets, no worker-template changes

## Docs gaps

- **CONTEXT.md**: the glossary binds "watch" to the Agent Bus channel; the watch skill's body prose avoids bare "watch" as a noun for supervision (says "supervise the board" / "board sweep") — add a one-line glossary disambiguation only if the prose gets awkward without it

## Best practices

- **Check-before-act:** every remediation verifies current state first — the highest-leverage defense against double-remediation [practice-scout]
- **Ladder tiers by reversibility and blast radius,** never model confidence; least-authority default, human approval for irreversible rungs
- **Page loud once, enrich quietly:** dedup notifications on a stable fingerprint; never re-page identical state
- **Don't fight the supervisor:** read the restart ledger / distress row before bouncing — launchd already respawns, and restarts mask root cause
- **Read-only at the connection is the guard** (`sqlite3 -readonly`); prose and keyword filters are not an enforcement layer
- **Negative trigger boundaries:** overlapping skill descriptions (autopilot / dispatch / watch) need explicit NOT-for exclusions both ways
