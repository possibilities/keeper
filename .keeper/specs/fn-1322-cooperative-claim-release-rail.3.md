## Description

**Size:** S
**Files:** docs/problem-codes.md, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/commit-via-keeper-default.md.tmpl, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/_index.yaml, plugins/prompt/test/oracle/fixtures/manifest.json, plugins/prompt/test/oracle/fixtures/render.json, plugins/plan/template/_partials/worker-implement-native.md, plugins/plan/template/_partials/worker-implement-wrapped.md, CONTEXT.md

### Approach

Land the rail's human- and agent-facing surfaces per ADR 0078, all
forward-facing (no epic ids, no history). problem-codes: revise the
ownership-conflict row to route through the request-release pointer
and fold the never-signal-a-live-peer stance into the existing
signal-safety family as ONE consistent voice — no new disconnected
section. The commit-work guidance snippet gains the request-release
path and the policy line (its index summary and token estimate
re-sync; the prompt-oracle golden fixtures regenerate in the SAME
change or the pinned renders go stale). Both worker manifest partials
route an ownership conflict to the rail and forbid signalling the
peer. CONTEXT.md gains two entries — the voluntary release record and
the request-release notice — placed beside (never inside) the Vacated
claim entry, each with an Avoid line, prune-first against the size
cap. Guidance-only for the policy (no CLAUDE.md line: the structural
piece already exists — no kill rail is exposed and terminate refuses
working sessions).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/problem-codes.md — the commit-work refusal table + signal-safety recovery prose to consolidate with
- plugins/prompt/corpus/.../commit-via-keeper-default.md.tmpl + snippets/_index.yaml — the snippet + its index entry (summary/token-estimate sync)
- plugins/prompt/test/oracle/fixtures/ + plugins/prompt/test/render_plugin_templates.test.ts — the golden fixture set to regenerate
- plugins/plan/template/_partials/worker-implement-native.md:~52 and worker-implement-wrapped.md:~73 — the ownership-conflict guidance to revise
- CONTEXT.md — the Vacated claim entry + the size cap; docs/adr/0078 for the exact vocabulary

**Optional** (reference as needed):
- docs/adr/0068 — add its amended-by note only if its foreign-terminal-only framing reads stale after the rail

### Risks

- Editing the partials leaves host worker manifests stale (the dispatch fingerprint gate fails closed on the NEXT dispatch) — the operator recompiles post-landing; note it in the Done summary
- Forgetting the fixture regeneration reds the prompt-oracle suite; forgetting the index token-estimate desyncs the snippet index

### Test notes

The prompt-oracle render suite green with regenerated fixtures; the
CLAUDE.md lint (`bun scripts/lint-claude-md.ts`) untouched surfaces
stay green; CONTEXT.md within its cap.

## Acceptance

- [ ] The refusal table, guidance snippet, and both worker partials route ownership contention to the request-release rail and state the never-signal policy in one consistent voice
- [ ] The prompt-oracle fixtures are regenerated in the same change and their suite is green
- [ ] The glossary carries the two new terms with Avoid lines, distinct from the vacated-claim entry, within the size cap
- [ ] The full fast correctness gates stay green

## Done summary
Routed ownership_conflict guidance (problem-codes, commit-via-keeper-default snippet, both worker partials) through the request_release rail with a consistent never-signal-a-live-peer stance; added the two CONTEXT.md glossary terms and regenerated the prompt-oracle fixtures + hack skill bake guard.
## Evidence
