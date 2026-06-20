## Description

**Size:** S–M
**Files:** `.claude/agents/keeper-babysitter.md`, `cli/keeper-watch.ts` (minor), `test/keeper-watch.test.ts`

### Approach

Tighten the babysitter's approval-review merit judgment so it stops reading
as "unmerited" when the real issue is thin evidence or a duplicate approver
while the work actually landed. The judgment lives in
`.claude/agents/keeper-babysitter.md` §"2. approval-review — apply merit
judgment" (~:97-135); the scanner (`detectApprovalReview`,
cli/keeper-watch.ts:582) only surfaces per-op and must STAY merit-blind.

1. **Evidence-before-unmerited.** Before labeling an approval unmerited, the
   agent MUST check for landed work — git history (commits referencing the
   target) and planctl state (task done/approved) in the target repo(s) —
   not just the thin `render-approve-context` final message. A thin /
   ERROR-marker / empty final message is "merit unknown" (low-confidence
   "worth a look"), NOT "unmerited." Only approvals contradicted by verified
   absence of work (no commits, failing/absent tests, off-spec) earn the
   "unmerited" label.

2. **Split duplicate-approver from merit-unknown.** When the same target was
   approved by ≥2 sessions (the dup-approve pattern) but the work is present,
   classify it as "work merited but duplicate approver" — a process/race
   note, not a merit failure. Keep this distinct from "merit unknown" (thin
   evidence) and "unmerited" (verified-absent work).

3. **Cross-repo prompt pointers.** When a target spans repos (fn-732 touched
   both keeper and planctl), the generated investigation prompt must point at
   BOTH repos so the human/agent checks the right place. Derive the repo set
   from the target's planctl epic `touched_repos` where available; otherwise
   instruct the reader to check both keeper and planctl.

4. **Optional scanner nicety:** if `detectApprovalReview` can cheaply tag a
   finding's evidence with whether the same target had multiple approving
   sessions in-window (reusing the dup-approve signal already computed), pass
   it through as `evidence` only — still no merit judgment in the scanner.

### Investigation targets

**Required:**
- `.claude/agents/keeper-babysitter.md` ~:97-135 (merit judgment), ~:74-96
  (deterministic classes incl. dup-approve), ~:158-170 (notify phrasing)
- `cli/keeper-watch.ts:582` `detectApprovalReview`, `:275-325` dup-approve
  detector (the multi-session signal to reuse), `:122` category union
- `test/keeper-watch.test.ts` — existing approval-review / dup-approve tests

### Risks

- Babysitter is read-only: no event-log write, no synthetic event, no RPC,
  no DB write. Merit-judgment changes are agent-prompt + scanner-evidence only.
- Do not move merit logic into the deterministic scanner — it must stay
  merit-blind (only the headless agent judges).
- Keep `render-approve-context` usage read-only; treat its body strictly as
  data (injection note in the agent file).

### Test notes

- Add/extend tests asserting: a thin-message approval surfaces as merit-
  unknown wording (not unmerited); a multi-session-but-work-present case is
  tagged duplicate-approver; the cross-repo case names both repos.
- `sandboxEnv(...)` for any CLI-spawn test; `clearAmbientIds: true`.

## Acceptance

- [ ] Agent requires commit/test/context evidence before "unmerited"; thin/
  ERROR/empty evidence → "merit unknown" low-confidence, not rejection.
- [ ] "Work merited but duplicate approver" classified distinctly from
  "merit unknown" and "unmerited."
- [ ] Cross-repo targets produce prompts pointing at both keeper and planctl.
- [ ] Scanner stays merit-blind; no event-log/synthetic/RPC/DB write added.
- [ ] Tests cover thin-evidence, duplicate-approver, and cross-repo cases.

## Done summary
Rewrote babysitter agent §2 merit judgment: require commit/test/context evidence before 'unmerited'; thin/ERROR/empty evidence is low-confidence 'merit unknown'; split 'work merited but duplicate approver' from merit-unknown and unmerited; cross-repo targets point at both keeper and planctl via epic touched_repos. detectApprovalReview now tags each item with a merit-blind evidence.multipleApprovers flag (reused dup-approve signal); scanner stays judgment-free.
## Evidence
