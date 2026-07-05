## Description

**Size:** S
**Files:** plugins/plan/skills/hack/SKILL.md

### Approach

Three surgical prose additions to the hack skill, all reference-shaped (point at sibling skills and existing sections, never re-teach), with zero new render cites and all six BAKE guards byte-untouched. (1) Research epics — a bullet in the Cross-skill orchestration section: a research epic is a normal planned epic whose deliverable is knowledge; gate follow-ups on `complete`, not `landed` (nothing merges — coordinate wording with the adjacent landed-vs-complete baked block WITHOUT editing inside any guard); the plan's specs must name the retrieval path (default: acceptance criteria write findings to `~/docs/<slug>.md` per the docs-dir convention; the task Done summary suffices for lightweight results); sizing clause — durable, multi-task, or daisy-chain-feeding research warrants an epic, while a bounded one-shot question is lighter as `keeper:handoff` or `keeper:pair`. (2) Blocked-worker collaboration, creator-side — a bullet in the same orchestration region: for epics this session scaffolds, this session IS `planner@<epic>`; when a worker blocks, the daemon wakes the creator once per block instance with a message that itself carries the full resume recipe (mechanics live in the bus/plan surfaces — reference, don't re-teach); plans MAY design deliberate check-in points where a worker returns `BLOCKED: DESIGN_CONFLICT` / `SPEC_UNCLEAR` rather than guessing. Two caveats are mandatory: TOOLING_FAILURE and unparseable categories never escalate (they mint a silent sticky suppression instead), and the handshake requires the epic's creator edge to resolve — an offline-but-known creator is durably queued and auto-woken, a purged or foreign-created epic delivers nowhere. (3) Powers inventory + pilot etiquette — one clause in the top-of-body preamble near the Agent Bus paragraph: keeper and its skills already cover multi-epic flows, worker collaboration, and manual piloting; manual piloting happens only on explicit human request or after asking — referencing the existing quiet-by-default section and take-over bullet, never restating them.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/hack/SKILL.md:13-15 — the preamble anchor for the powers/etiquette clause
- plugins/plan/skills/hack/SKILL.md:222 — the quiet-by-default section the clause references
- plugins/plan/skills/hack/SKILL.md:234-250 — the Cross-skill orchestration section (bullets land here)
- plugins/plan/skills/hack/SKILL.md:251-263 — the landed-vs-complete BAKE guard: do not perturb a single byte inside it
- plugins/plan/skills/plan/references/operator-orchestration.md:19-34 — the blocked-agent mechanics the new bullet references
- src/daemon.ts:521-528 — the escalation category denylist the caveat states

**Optional** (reference as needed):
- src/reducer.ts:6957 — the creator edge minted at scaffold (grounds the creator-edge caveat)
- src/bus-wake.ts — the offline-creator wake path

### Risks

- Bake drift: any byte change inside a guard fails the vendored-corpus check — every addition lands outside the guards; the guard count stays six.

### Test notes

`bun scripts/vendor-corpus.ts --check`; prompt suite (reachability + bake gates). Visual: the three additions read as reference-shaped bullets, no restated mechanics.

## Acceptance

- [ ] The Cross-skill orchestration section carries a research-epic topology bullet: complete-gated (not landed), a named retrieval path with the `~/docs/<slug>.md` default, and the epic-vs-handoff/pair sizing clause
- [ ] A creator-side blocked-worker bullet states the wakeup contract with both caveats (TOOLING_FAILURE/unparseable never escalate; creator-edge durability)
- [ ] The preamble carries the powers + ask-first piloting clause, referencing (not restating) quiet-by-default and the take-over window
- [ ] All six BAKE guards are byte-identical (vendored-corpus check green), zero new render cites, prompt suite green

## Done summary

## Evidence
