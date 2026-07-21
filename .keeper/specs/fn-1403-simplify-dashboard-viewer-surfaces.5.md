## Description

**Size:** S
**Files:** cli/setup-tmux.ts, test/setup-tmux.test.ts

### Approach

Replace the Board-plus-splits dashboard topology with an ordered declarative window specification: `jobs`, `autopilot`, `board`, `summary`, `git`, and `usage`, each running the same-named Keeper command in one pane. Create the first named window with `new-session`, create the remaining five with `new-window`, capture stable tmux IDs, disable automatic rename for managed windows, and select Board after successful creation.

Preserve the dedicated `-L dash` socket, inherited-TMUX clearing, home cwd, shell argv boundaries/fallback, size detection, identity lease, timeout recovery, self-teardown refusal, work-session provisioning, restore flow, and fail-open boundary. A failed rebuild must not report a successful six-window dashboard or leave setup targeting ambiguous window names.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/setup-tmux.ts:57 — public setup contract and old pane help.
- cli/setup-tmux.ts:133 — current sub-pane specification.
- cli/setup-tmux.ts:617 — dash new-session argv builder.
- cli/setup-tmux.ts:666 — split/layout/select builders to replace.
- cli/setup-tmux.ts:930 — identity-guarded destructive rebuild and safety rails.
- cli/setup-tmux.ts:1616 — self-teardown refusal.
- test/setup-tmux.test.ts:83 — old no-Usage and three-subpane assertions.
- test/setup-tmux.test.ts:204 — exact new-session/split/layout argv fixtures.

**Optional** (reference as needed):
- src/exec-backend.ts:920 — safe tmux rename argv pattern.
- src/tmux-session-cwd.ts:1 — canonical Keeper tmux cwd.
- https://github.com/tmux/tmux/wiki/Advanced-Use — stable object IDs and formatted creation output.

### Risks

Names are not unique tmux identities, so later mutations/selects must use captured IDs or exact targets. Setup always destroys attached dashboard clients and can race another setup; preserve current identity and timeout guards rather than introducing a partial in-place reconciler.

### Test notes

Keep the injected-spawn test seam. Assert exact ordered argv for one named new-session plus five named new-window calls, one command per window, automatic rename disabled, Board selected, no split/layout operations, `-L dash` on every dashboard operation, and unchanged recovery/default-server/restore behavior.

### Detailed phases

1. Replace pane constants/builders with a six-window desired specification.
2. Rebuild using captured window IDs and explicit names.
3. Remove split/layout/refocus assumptions and select Board.
4. Update help and exact argv/safety fixtures.

### Alternatives

Mapping Summary to `keeper dash` is rejected because the commands differ. In-place reconciliation is rejected for this change because destructive replacement is the established identity/recovery contract and is simpler to verify atomically.

### Non-functional targets

All tmux calls remain bounded, argv-safe, socket-qualified, and idempotent at the setup-command level. Repeated successful setup produces exactly the same six-window topology.

### Rollout

Source changes do not alter an already-running dash server; the operator deliberately reruns setup from outside that server after landing.

## Acceptance

- [ ] A successful setup creates exactly six one-pane windows in order: jobs, autopilot, board, summary, git, usage; each launches the same-named Keeper command.
- [ ] Managed window names remain stable with automatic rename disabled, and Board is the selected window after creation.
- [ ] No dashboard `split-window`, pane-layout, or pane-refocus operation remains.
- [ ] Dedicated-socket targeting, TMUX clearing, home cwd, shell fallback, sizing, recovery identity, self-teardown refusal, work provisioning, and restore behavior remain covered and unchanged.
- [ ] Partial creation cannot be reported as a successful six-window dashboard, and all exact-argv setup tests pass without launching real tmux.

## Done summary

## Evidence
