## Description

**Size:** M
**Files:** ~/docs/arthack-dissolution-study.md (+ yaml sidecar) — research deliverable, no keeper source changes

### Approach

Three passes, one document. INVENTORY: enumerate every keeper→arthack edge — the launch
config and its install/stow assumptions; the snippet corpus authoring home vs keeper's
vendored subset (post-corpus-epic reality); the claude/arthack hook layer sub-hook by
sub-hook (each rewrite, the auto-approve, each advice/reminder table); every arthack CLI
named in keeper/plan skill bodies and docs; anything else a grep for arthack and the ctl
names surfaces. Ground each edge in file:line and, where the telemetry epic's observation
data exists, in observed usage (which rewrites actually fire, what auto-approve actually
covered, which reminder entries ever matched — read keeper.db readonly). DESIGN: the
standalone end state — what keeper owns natively, what remains an optional plugin a machine
may add, what dies. Answer the deferred gate question: should workers get a plugin-isolation
gate, informed by what workers actually consumed from the arthack layer (note their
permission mode at launch — if workers run permission-skipped anyway, auto-approve is
redundant for them and the gate is low-risk). VERDICT: the own/gate/drop matrix, then a
proposed follow-up epic decomposition sized for /plan:plan. Deliver as a ~/docs document
with sidecar; no code changes in this task.

### Investigation targets

**Required** (read before coding):
- The telemetry epic's landed composition map + attributability output
- ~/code/arthack/claude/arthack/hooks/{pre_tool_use,post_tool_use,user_prompt_submit,permission_request}.ts — the behavior inventory
- src/agent/{config,plugins,main}.ts + src/exec-backend.ts — every launch channel
- keeper.db (readonly) — observed hook-action data post-attribution

### Risks

- Scope creep into implementation — the deliverable is the study and the follow-up plan proposal, nothing lands in src/.

### Test notes

None (research). The document's Acceptance checkboxes are the bar.

## Acceptance

- [ ] Inventory complete with file:line + observed-usage grounding
- [ ] Own/gate/drop matrix with rationales; worker-gate question answered with data
- [ ] End-state design + follow-up epic decomposition ready for /plan:plan

## Done summary
Delivered ~/docs/arthack-dissolution-study.md (+ yaml sidecar): full keeper→arthack edge inventory (launch config, hook layer, prompt corpus, CLI refs) with file:line + observed-usage grounding; 18-row own/gate/drop verdict matrix; the worker plugin-isolation gate answered with data (workers run permission_mode=default, auto_approve is load-bearing — gate is right but gated on keeper owning worker perms + corpus); standalone end-state design + 6-epic follow-up decomposition ready for /plan:plan.
## Evidence
