## Description

**Size:** M
**Files:** src/dispatch-failure-key.ts (new), src/autopilot-worker.ts, src/reconcile-core.ts, src/daemon.ts, src/dispatch-failure-pill.ts, src/await-conditions.ts, test/dispatch-failure-key.test.ts (new)

### Approach

One dep-free leaf module exporting a parse over the dispatch-failure identity: (verb, id, reason, dir) → a discriminated union with LITERAL kind types (never widen kind to string — that silently disables exhaustiveness narrowing), plus an assertNever tripwire in every consuming switch. This is a semantics-PRESERVING router, not a normalizer: shouldEscalateMergeConflict's exact leading-token match (daemon.ts:955, token before the first colon, trimmed), isWorktreeRecoverReason's prefix match (autopilot-worker.ts ~:655), and the WORKTREE_FINALIZE_ID_PREFIX match on the ID not the reason (~:5407 in loadReconcileSnapshot) each keep their exact semantics, encoded inside the parser variants. Variants cover at least: plain close::<epic>, worktree-recover (epic+repoHash and the null-epic dir-slug form), worktree-finalize (epic+repoHash), worktree-merge-conflict, worktree-finalize-non-fast-forward, work-task keys, and an unknown variant that preserves the raw strings. Route the named call sites through it. Single vocabulary source: dispatch-failure-pill.ts's CLASSIFY_RULES must share one rules/constants table with the classifier (derive the pill KIND from the union or build both from one table) — two prefix tables of the same vocabulary is the drift this epic exists to kill. await-conditions.ts is a deliberate import leaf with local token copies pinned by a drift-equality test: adopt the classifier there ONLY if it keeps the module a clean leaf (the classifier is itself dep-free, so this should hold); otherwise keep the local copies and extend the drift-pin test to pin them against the classifier's exported constants. The classifier parses at the read boundary only — never inside a fold; the merge_escalated_at column gate stays with its caller (daemon.ts). Durable reason-string vocabulary is untouched; no migration; no SCHEMA_VERSION change.

### Investigation targets

**Required** (read before coding):
- src/dispatch-failure-pill.ts — CLASSIFY_RULES table and its "never substring-contains" discipline
- src/daemon.ts:876-955 — the merge-escalation sweep: exact-token match + column gate split
- src/autopilot-worker.ts ~:638-707 — recoverFailureDispatchId and the recover/finalize key mint+parse pair
- test/await-conditions.test.ts drift-equality test — the leaf contract to preserve or extend
- src/collections.ts:604-628 — the dispatch_failures descriptor (verb pk + liveKeyColumns)

### Risks

Collapsing exact-token semantics into prefix semantics (or id-matching into reason-matching) silently changes autopilot control flow — mis-escalation or wrong auto-clear scope. The identity property test below is the guard. Two-table drift with the pill module if the single-source rule is skipped.

### Detailed phases

1. Grep-collect the full catalog of reason/id shapes minted anywhere (constants + template literals). 2. Define the union + parser with per-variant match semantics. 3. Identity property test: old predicates vs new routing agree over the catalog + fuzzed near-misses. 4. Route the call sites. 5. Unify the pill table. 6. await-conditions adoption or drift-pin extension.

### Alternatives

If unifying the pill table turns invasive, keep CLASSIFY_RULES separate but generate both from one shared constants module in this task — the non-negotiable is one vocabulary source, not one table shape.

### Test notes

Exhaustive unit tests on the parser incl. the historical collision shapes (recover vs finalize rows sharing close:: keyspace, per-(epic,repo) suffixes, the dir-slug null-epic form, non-fast-forward escalation reason); the identity property test over the minted catalog; assertNever compile-time tripwire proven by a scratch variant addition.

## Acceptance

- [ ] All named substring/prefix/token sites route through the classifier with semantics proven identical (old === new over the full minted catalog)
- [ ] Literal-kind union + assertNever tripwire; adding a variant breaks compilation of unhandled switches
- [ ] One vocabulary source shared with dispatch-failure-pill.ts
- [ ] await-conditions.ts leaf contract preserved (adoption or extended drift-pin)
- [ ] Durable strings, projections, and SCHEMA_VERSION untouched; `bun test` green

## Done summary
Added src/dispatch-failure-key.ts: a dep-free leaf holding the single dispatch-failure vocabulary plus a semantics-preserving typed row router (literal-kind union + assertNever). Routed the merge-escalation gate, recover-clear, and finalize-clear sites through it, and unified the pill table + await-conditions jam leaf on the same source.
## Evidence
