## Description

Covers finding F1 (audit of fn-1380-harden-poison-gate-and-fence-clears).
Evidence path from the vet: the `probeLiveness` closure in the
`retry-dispatch-request` handler (src/daemon.ts:10387-10405) has three
`inconclusive` arms — (a) null/empty `claim.session_id`, (b) absent `jobs`
row for that session, (c) a job row with null `pid` or null/empty
`start_time` — that decide whether an operator dispatch-clear may stomp a
live worker. The pure `decideDispatchClearLiveness`
(src/daemon.ts:688-700, tested at test/daemon.test.ts:5565-5607) and the
typed `refused_live`/`refused_identity` replies (test/rpc-handlers.test.ts:1560,1576)
are covered, but the closure's db-lookup-to-verdict mapping and the
main-side reply construction are only reached indirectly through the stub
bridge.

Add direct coverage. Prefer extracting the closure's job-lookup arms into a
pure helper (taking a claim + job row and returning the
`RecordedProcessIdentityVerdict` input) so each arm is a pure assertion; or,
if the seam is left inline, drive it with a `freshMemDb` seeded with
`dispatch_claims` + `jobs` rows. Also assert the handler emits `refused_live`
for a bound-live claim, `refused_identity` on an attempt-identity CAS miss,
and `cleared` on a gone/unbound claim — against the real handler path, not
the injected stub. Stay within the no-real-daemon test discipline (no real
Worker, socket, subprocess, or git).

Files: src/daemon.ts (probeLiveness closure / possible pure extraction),
test/daemon.test.ts and/or test/rpc-handlers.test.ts.

## Acceptance

- [ ] Each of the three closure `inconclusive` arms (null/empty session_id, absent job, partial job) is directly asserted to refuse-live.
- [ ] The `gone` arm (live-and-recorded-dead) is asserted to clear.
- [ ] Main-side `refused_live` / `refused_identity` / `cleared` reply construction is asserted against the real handler path (or an extracted pure seam).
- [ ] Tests are deterministic, in-process, behind a named `*.test.ts` gate; no real daemon/Worker/socket/subprocess.

## Done summary
Extracted the probeLiveness closure into a pure probeDispatchClearClaimLiveness helper and the retry-dispatch reply construction into buildRetryDispatchResultMessage; added direct daemon tests covering the null/empty-session, absent-job, and partial-job inconclusive arms, the gone-clears arm, and the refused_live/refused_identity/cleared reply paths against the real handler seams.
## Evidence
