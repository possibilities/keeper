## Description

**Size:** S
**Files:** plugins/keeper/skills/autopilot/SKILL.md, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/orient.md.tmpl

### Approach

Bring the agent-facing autopilot docs onto the stored-vs-effective contract the code now implements, using the exact field names the status envelope emits. The load-bearing fix is the take-over capture/restore contract: capture MUST read the stored field and restore MUST write it back via `config max_concurrent_per_root <stored>` — capturing the effective value while worktree mode is off would restore 1 into stored and re-clobber the durable intent, the exact bug class this epic removes. State that contract explicitly.

Also: the caps-table row says setting the per-root cap is legal any time (stores intent; effective floors to 1 while worktree is off); the status/capture JSON examples show both fields; the viewer-read prose reports both values; the orient snippet's autopilot envelope field list gains the stored field. Prune-and-rewrite per docs discipline — no appended history, no plan ids; keep glossary vocabulary ("worktree mode", "per-root cap").

Verify examples against the real envelopes (run `keeper status --format json | jq .data.autopilot` and `keeper autopilot show` against the dev daemon, or read the landed serializers) so documented shapes match what ships.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/autopilot/SKILL.md:66 — caps table row; :96 status example; :122-166 capture/restore contract incl. the field list at :132-136; :225-231 viewer-read prose
- plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/orient.md.tmpl:21 — the `data.autopilot` field list naming max_concurrent_per_root
- The landed status/show serializers from the prior task — the source of truth for field names in examples

**Optional** (reference as needed):
- CONTEXT.md "Per-root cap" glossary entry — the vocabulary anchor for all prose

### Risks

- Docs drifting from the landed field names — this task depends on the surfacing task precisely so examples can be checked against landed reality, not the plan.

### Test notes

Prose-only change; verification is grep-shaped: no occurrence of reject-while-off / pins-back-to-1 phrasing remains under plugins/, and every JSON example field name matches the landed envelope. Run the prompt-corpus test suite if the snippet template is covered (`bun run test:full` prompt tier or its targeted subset).

## Acceptance

- [ ] The autopilot skill's take-over capture/restore contract round-trips the stored per-root value and says why effective must not be restored
- [ ] No prose under plugins/ still claims the per-root cap is rejected while worktree mode is off or pinned to 1 on toggle
- [ ] Every documented status/show JSON example matches the field names and shapes the landed envelopes emit
- [ ] The orient snippet's autopilot envelope field list includes the stored field

## Done summary

## Evidence
