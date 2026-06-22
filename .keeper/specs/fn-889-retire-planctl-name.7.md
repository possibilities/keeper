## Description

**Size:** S
**Files:** cli/** (~65 hits / 5 files)

### Approach

AST codemod of the `cli/**` TS surface (allowlist-guided, AST-only, one atomic commit, rerere).
Targets: `cli/plan.ts:22` `planctlMain`; the `cli/await.ts` `"planctl"` slot KIND + types
(~56 hits) — **VERIFY the discriminant is never serialized to the external met/failure line**
(`cli/await.ts:709,916`) before renaming (a prior worker confirmed it safe — re-confirm);
`cli/commit-work.ts:69-76` — rename incidental symbols/comments but KEEP the frozen passthrough
regex (`:72`).

### Investigation targets

**Required:**
- cli/await.ts:238,399,623-624,709,916 (planctl slot kind + the external-line contract to verify non-serialized)
- cli/plan.ts:22 (planctlMain)
- cli/commit-work.ts:69-76 (frozen regex — KEEP)

### Risks

- await.ts discriminant: confirm `kind:"planctl"` is never serialized externally BEFORE renaming.

### Test notes

`bun test` (fast) + the .1 lint guard green over the cli scope.

## Acceptance

- [ ] cli/** planctl symbols/types renamed across case variants; await.ts discriminant confirmed non-serialized; frozen regex in commit-work.ts UNCHANGED
- [ ] one atomic mechanical commit; lint guard green over the cli scope

## Done summary

## Evidence
