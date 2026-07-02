## Description

**Size:** S
**Files:** cli/autopilot.ts, src/git-toplevel.ts, src/autopilot-worker.ts (producer reject site), test/autopilot-cli.test.ts or sibling

### Approach

Two bounded changes. (1) CLI exposure: the `config` verb whitelist (cli/autopilot.ts:1167 region) accepts only max_concurrent_jobs and max_concurrent_per_root; add `worktree_multi_repo` taking on/off, mapped to a boolean patch through the existing set_autopilot_config RPC — the handler already validates it (src/rpc-handlers.ts:430-438). Mirror the existing worktree on/off argument parsing; update the CLI usage text. (2) Accurate reject: find the mint site of the `worktree-repo-unresolved: epic <id> root <dir> is not inside a git worktree` reason (the doc comment at src/git-toplevel.ts:90 describes the reject; the template lives with the producer) and reword the multi-toplevel case to state what is true — the epic spans repos outside the worktree-mode root and `worktree_multi_repo` is off — naming the exact command that unjams it. Keep the reason's stable `worktree-repo-unresolved` prefix untouched (sticky-row routing keys on it). Do NOT change the flag's default in this epic.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:1150-1200 — the config verb parser and its usage text
- src/rpc-handlers.ts:356-438 — the accepted set_autopilot_config patch shape
- src/git-toplevel.ts:80-120 — the multi-toplevel reject contract
- The reason template mint site (grep the interpolated phrase; it is not in git-toplevel.ts itself)

### Risks

The reason string's prefix is a routing key — reword only the human-facing tail. The flag flip itself stays an operator action; this epic only makes it possible without hand-crafted socket writes.

### Test notes

CLI test: config verb round-trips worktree_multi_repo on/off envelopes. Reject test: the multi-toplevel case emits the new wording with the preserved prefix.

## Acceptance

- [ ] `keeper autopilot config worktree_multi_repo on|off` works end to end
- [ ] Multi-toplevel reject reason is accurate and actionable, prefix preserved
- [ ] Tests cover both; `bun test` green

## Done summary

## Evidence
