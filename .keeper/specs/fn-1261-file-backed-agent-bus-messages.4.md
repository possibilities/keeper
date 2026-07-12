## Description

**Size:** S
**Files:** README.md, plugins/keeper/skills/bus/SKILL.md

### Approach

Update the public front door and agent-facing bus skill to describe one current workflow: send normally, then the receiver follows the explicit artifact path. Remove inline-short versus spilled-long guidance, state that content does not ride the bus, retain truthful send/wake outcomes and evidence-first trust framing, and explain metadata-only failure notifications without duplicating implementation internals.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- README.md:1 — lean front-door structure and appropriate location for a concise usage note.
- plugins/keeper/skills/bus/SKILL.md:57 — current inline/spill receive guidance.
- plugins/keeper/skills/bus/SKILL.md:64 — current send workflow and outcomes.
- CONTEXT.md:104 — canonical Agent Bus and Bus message artifact vocabulary.

**Optional** (reference as needed):
- docs/adr/0048-file-backed-agent-bus-messages.md:1 — rationale and settled boundaries; do not re-narrate history in forward-facing docs.

### Risks

README must stay a lean front door, and skill prose must not imply that a displayed path is automatically trusted or shell-executed. Docs must preserve the distinction between Presence, delivery, notification, and successful artifact reading.

### Test notes

Run generated-skill and help-purity checks that cover the touched prose, plus the relevant bus CLI tests to ensure examples match accepted syntax.

### Detailed phases

1. Replace the skill's size-dependent receive explanation with the explicit read-path contract.
2. Add a compact README entry pointing to the canonical command and behavior.
3. Prune duplicated or stale preview/spill wording rather than appending parallel explanations.

### Alternatives

Documenting only the CLI help was rejected because the bus skill is the model's canonical operating contract. A long README runbook was rejected because README is intentionally a lean front door.

### Non-functional targets

Forward-facing prose describes only current behavior, uses canonical glossary terms, and adds no implementation history outside ADRs.

### Rollout

Documentation lands after both producer/consumer and lifecycle behavior so examples reflect the final contract.

## Acceptance

- [ ] Agent-facing guidance states that every new message arrives as an explicit artifact read path, with no inline body or size-dependent preview behavior.
- [ ] Send, miss, queued-for-wake, trust, and Presence semantics remain accurate and non-duplicative.
- [ ] README gains only a concise discoverability entry and remains a lean front door.
- [ ] Forward-facing docs use the canonical Bus message artifact term and contain no stale receiver-spill guidance.

## Done summary
Replaced size-dependent inline/spill receive guidance in the bus skill with the explicit confined-path artifact-read contract, and added a concise README discoverability entry, using the canonical Bus message artifact term throughout.
## Evidence
