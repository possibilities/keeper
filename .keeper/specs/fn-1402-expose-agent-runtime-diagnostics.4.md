## Description

**Size:** S
**Files:** plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/await/SKILL.md, README.md, docs/install.md, docs/problem-codes.md, docs/agent-surface-contracts.md

### Approach

Make the new commands and threshold semantics discoverable through the existing query and await skills, keeping each skill's trigger boundary sharp. Query should route runtime, Usage, and account-inspection questions to their purpose-built versioned reads before generic projections; await should distinguish same-Session foreground context actions from durable frozen-route quota actions and always carry an explicit follow-up document when the requested action matters.

Consolidate operational documentation rather than appending parallel runbooks. Define the three independent contracts, partial/unavailable behavior, timestamps and provenance, safe fields, frozen-route versus independent follow-up routing, exact condition grammar, problem codes, cancellation/timeout recovery, and post-land examples. Prune stale fixed collection counts and superseded `accounts check` recommendations while retaining the command's compatibility status.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/skills/query/SKILL.md:110-125` — stale hand-maintained collection inventory and current read hierarchy.
- `plugins/keeper/skills/await/SKILL.md:163-174` — foreground Monitor orchestration contract.
- `plugins/keeper/skills/await/SKILL.md:312-341` — foreground terminal handling and durable fresh-Session behavior.
- `docs/agent-surface-contracts.md:1-20` — canonical agent-interaction contract genre.
- `docs/install.md:125-151` — account Usage/routing operational guidance and provenance boundary.

**Optional** (reference as needed):
- `docs/adr/0103-agent-runtime-diagnostics-and-threshold-awaits.md:1` — accepted machine/threshold decision.
- `docs/skill-authoring.md:1` — progressive-disclosure and deterministic skill conventions.
- `README.md:1` — lean front-door constraint.

### Risks

Skill trigger expansion can make ordinary code questions route into Keeper inspection, while duplicated docs can drift between human Usage, routing authority, and await semantics. Keep examples machine-safe, current-tense, and explicit that `done` is launch acceptance rather than follow-up completion.

### Test notes

Run the repository's skill/frontmatter, source-comment, CLAUDE/CONTEXT, and docs lint gates through `keeper commit-work`; add or update targeted content-contract tests only if the repository already pins exact help/skill wording.

### Detailed phases

1. Update skill triggers, command hierarchy, examples, and durable follow-up instructions.
2. Consolidate README/install/problem-code guidance and remove obsolete duplicate paths.
3. Add the machine schemas and lifecycle semantics to the canonical agent-surface contract.
4. Cross-check every command, enum, problem code, and example against landed behavior.

### Alternatives

A new telemetry skill was rejected because query already owns read-only Keeper facts and await already owns condition/action orchestration. Embedding the complete schemas in every skill was rejected in favor of one canonical contract plus concise operational examples.

### Non-functional targets

Documentation remains within repository size caps, uses forward-facing language, contains no raw account/provider examples that look like PII, and gives copy-paste commands whose stdout/stderr assumptions match the versioned contracts.

### Rollout

Skills and docs land only after all three implementation contracts exist, so no deployed skill advertises unavailable commands or condition kinds. Compatibility guidance keeps existing account checks valid without presenting them as the preferred agent path.

## Acceptance

- [ ] The query skill routes current-runtime, Usage-meter, and account-balancing questions to the three purpose-built machine commands before generic query or sqlite fallbacks.
- [ ] The await skill documents exact context/quota grammar, foreground versus durable eligibility, frozen-route semantics, transition/probe/AND behavior, stale/unavailable waiting, explicit durable follow-ups, and terminal handling.
- [ ] Canonical docs define independent schema/version and timestamp provenance, partial-data behavior, safe-field boundaries, actual versus initial/would-route distinctions, and launch-accepted versus work-completed semantics.
- [ ] Installation and problem-code guidance provide exact commands and recovery paths for missing runtime, route-freeze refusal, stale observations, timeout, cancel, and follow-up launch failure without duplicate runbooks.
- [ ] README and operational docs present the new commands as preferred agent diagnostics while preserving `keeper agent accounts check --json` compatibility.
- [ ] Stale collection counts, obsolete temporary-artifact parsing guidance, and any implication that display Usage authorizes routing are removed.
- [ ] Repository documentation and skill lint gates pass within size limits with forward-facing, PII-free prose.

## Done summary
Wired the query and await skills to the three new schema-v1 runtime/Usage/routing commands and the context/weekly-quota threshold-await grammar, added the canonical contract to agent-surface-contracts.md, and consolidated README/install/problem-codes guidance with exact recovery commands.
## Evidence
- Commits: 770b2b9ea9657facba56c34557a5d4b829ca45f6