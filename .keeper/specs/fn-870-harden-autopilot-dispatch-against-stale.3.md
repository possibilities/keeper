## Description

**Size:** S
**Files:** src/dispatch-command.ts, src/rpc-handlers.ts, cli/autopilot.ts, test/control-rpc.test.ts, README.md, CLAUDE.md

### Approach

Give operators a way to clear a stuck/phantom dispatch for the `approve` verb
(today `keeper autopilot retry` rejects it: "verb must be one of work|close").
EXTEND the existing `retry_dispatch` surface rather than adding a new RPC (keeps
the five-surface RPC-write whitelist intact): widen `RETRY_DISPATCH_VERBS` + the
single dep-free validator `parseDispatchKeyResult` (`src/dispatch-command.ts:25/54`)
to accept `approve`, so `retry_dispatch` emits `DispatchCleared` for an
`approve` key. The `DispatchCleared` fold (after task .1) deletes the failure +
counter + pending row, so an `approve` clear immediately un-starves. Update the
`keeper autopilot` CLI help + README CLI reference + the RPC-surface note (still
five surfaces — this widens an existing one, does not add a sixth).

### Investigation targets

**Required** (read before coding):
- src/dispatch-command.ts:25 `RetryDispatchVerb` / :27 `RETRY_DISPATCH_VERBS` / :54 `parseDispatchKeyResult` (the single validator to widen).
- src/rpc-handlers.ts:399 `retryDispatchHandler`, :354 `parseDispatchKey`; the five-surface list.
- cli/autopilot.ts:54/68/435/442 retry subcommand (already models `approve` in the list path :176/214); src/types.ts:285 verb whitelist `{plan,work,close,approve}`.
- test/control-rpc.test.ts retry_dispatch validation.

### Risks

- Confirm the clear path reaches a real `DispatchCleared` fold for `approve`; even if the reconciler never dispatches `approve` itself, the clear surface is still valid for clearing a resurrected/phantom `approve` pending (the actual incident shape).

### Test notes

`bun run test:full`. Add control-rpc cases: `approve::<id>` accepted + emits `DispatchCleared`; the five-surface count unchanged.

## Acceptance

- [ ] `keeper autopilot retry approve::<id>` is accepted (`parseDispatchKeyResult` + `RETRY_DISPATCH_VERBS` widened) and emits `DispatchCleared`
- [ ] The five-surface RPC-write whitelist is unchanged (`retry_dispatch` widened, no new RPC)
- [ ] CLI help + README/CLAUDE CLI+RPC docs updated (forward-facing); `bun run test:full` green

## Done summary

## Evidence
