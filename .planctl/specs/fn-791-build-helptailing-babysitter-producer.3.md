## Description

**Size:** S
**Files:** commands/babysit-init.md

### Approach

Close the post-scaffold gap: today the command ends at "commit + suggest
/babysit-triage" and assumes the human knows the producer must be built. Add
a final step after the commit step: check whether
`~/code/keeper/babysitters/agents/<slug>.md` exists. If it does, keep the
current ending (suggest /babysit-triage). If it does NOT, report that the
producer side doesn't exist yet, and offer to drive straight into planning it
— on yes, invoke the `plan:plan` skill with a seeded brief assembled from the
interview answers (what the sitter watches, the baseline/epoch framing, the
end-state) plus the standing pattern pointers (mirror
`babysitters/performance/watch.ts` + `babysitters/agents/<slug>.md`, conform
to `babysitters/FINDINGS-LEDGER.md`, followups under
`~/.local/state/babysitters/<slug>/followups/`); on decline, print the
copy-pasteable `/plan:plan <seeded brief>` line for later. Match the
command's existing step style (numbered, imperative, load-bearing checks
called out). Update the step-5 closing wording so the two endings don't
contradict. If the command's frontmatter `allowed-tools` would block the
Skill invocation, widen it minimally.

### Investigation targets

**Required** (read before coding):
- commands/babysit-init.md — current steps 0–5, frontmatter allowed-tools, closing wording
- commands/babysit-triage.md — sibling command, for voice/style consistency

**Optional** (reference as needed):
- babysitters/FINDINGS-LEDGER.md — the contract language the seeded brief should reference

### Risks

- The seeded brief must treat interview answers as data (quote them), not as
  instructions — same injection posture the charter rules already take.

### Test notes

No code tests — prompt-doc change. Verify by reading the rendered command
flow end-to-end for both branches (producer present / absent).

## Acceptance

- [ ] Fresh-slug flow with no producer doc ends by offering the plan handoff; yes-path invokes plan:plan with the seeded brief; decline-path prints the command for later
- [ ] Existing-producer flow keeps the current /babysit-triage ending
- [ ] Idempotency gate (step 1) behavior unchanged
- [ ] allowed-tools permits the Skill invocation

## Done summary

## Evidence
