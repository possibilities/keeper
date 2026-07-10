## Description

**Size:** S
**Files:** plugins/keeper/skills/await/SKILL.md, CONTEXT.md

### Approach

Rewrite the await skill's steering so the next agent picks the right
predicate: a when-to-use table over the condition vocabulary (complete
vs landed vs started vs the drained scope axis), the drained row split
by scope with the plan-default called out, the probe invocation form,
the heartbeat/terminal grammar as shipped, and the reconnect prose
corrected (reconnect-forever is the default for all conditions, not a
server-up special). Revise-and-consolidate, never append-only; keep the
pointer-snippet idiom and the terminal-contract section accurate to the
shipped stdout shapes. Add the CONTEXT.md vocabulary: the dual-scope
drained term and a term for keeper-dispatched board-work sessions vs
adopted/external sessions — "unmanaged" is banned by the Adopted job
entry's avoid-list; follow the `- **Term**: definition. Avoid: ...`
shape. If the prompt-corpus landed-vs-complete snippet can be updated
through its sanctioned re-vendor flow, add one line placing plan-scope
drained in the daisy-chain guidance; skip cleanly if the canonical
source is unreachable — never hand-edit the vendored copy.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md — condition table (:53),
  terminal grammar (:185-217), exit table (:243-253), reconnect prose
  (:51, :250)
- CONTEXT.md:100 — the Adopted job entry whose avoid-list bans
  "unmanaged job"
- cli/await.ts HELP/AGENT_HELP as landed by tasks 1-3 — the tables must
  mirror the shipped flags/codes exactly

### Risks

- Skill tables drifting from shipped HELP — cross-check every flag,
  code, and default against the landed CLI before writing

### Test notes

bun scripts/lint-skill-ids.ts stays green; the corpus drift gate
(bun scripts/vendor-corpus.ts --check) stays green whether or not the
snippet is updated.

## Acceptance

- [ ] The await skill documents the scope axis (plan default), probe,
  heartbeats, terminal grammar, and reconnect default accurately
  against the shipped CLI, with a when-to-use table over the condition
  vocabulary
- [ ] CONTEXT.md defines the drained scopes and the session-class
  vocabulary without banned terms
- [ ] Skill and corpus lint gates are green

## Done summary
Rewrote the await skill's steering (when-to-use table, drained scope-split row, --probe section, heartbeat/retryable terminal grammar, corrected reconnect-forever prose) and added CONTEXT.md's Drained scope + Board-work session vocabulary; corpus/vendor.lock left untouched (Docs-gap item, not in Files list).
## Evidence
