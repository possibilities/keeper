## Description

**Size:** S
**Files:** src/tmux-control-worker.ts, test/tmux-control-parser.test.ts

### Approach

The control-mode invariants header (src/tmux-control-worker.ts ~:23-36) pins the
contract to "host tmux is 3.6b"; the live host serves 3.7b (`tmux -V`). Re-verify
each 3.6-era invariant against 3.7b: no-output set once at attach + refresh-client
re-assert (the ≤3.6 off→on toggle hang), the defensive `copy-mode -q` (3.6b lacks
`%config-error`; 3.7 emits it), and the %exit id-discard rule. For each: keep it
(annotated with the 3.7b-verified reason — forward-facing wording only, no version
archaeology beyond what the invariant needs), adapt it, or remove it with proof.
Update the header to state the verified host truth. If 3.7b emits control-mode
notifications the parser does not recognize (e.g. %config-error), extend the parser
fixture corpus in test/tmux-control-parser.test.ts to cover them benignly. Run the
task from the epic lane but verify against the LIVE host tmux version probe — the
lane tree is authoritative for source, the host for tmux behavior.

### Test notes

Parser fixtures stay pure string-in/struct-out; any live-tmux observation lands as
a fixture, never a spawned server in the correctness gates.

## Acceptance

- [ ] Header states the verified live-host tmux contract; no stale version claim remains
- [ ] Each 3.6-era workaround is kept-with-verified-reason, adapted, or removed with proof — recorded in the task evidence
- [ ] Any newly-recognized 3.7b control-mode notification is covered by a parser fixture; `bun test ./test/tmux-control-parser.test.ts` and `bun run typecheck` green

## Done summary
Re-verified all four 3.6-era control-mode invariants live against the host's tmux 3.7b (no-output set-once/re-assert, defensive copy-mode -q, %config-error emission, %exit id-discard) and rewrote the header to state the 3.7b truth with forward-facing reasons; added a live-captured %config-error parser fixture.
## Evidence
