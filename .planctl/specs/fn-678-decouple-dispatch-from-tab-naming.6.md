## Description

**Size:** S
**Files:** CLAUDE.md, README.md

### Approach

Document the final state and scrub the fn-674 name-as-oracle rationale so
it does not survive as misleading guidance. In CLAUDE.md: add `Dispatched`
/ `DispatchExpired` to the sole-writer synthetic-event enumeration; replace
the fn-674 "Closes the launch → SessionStart blind window via a per-cycle
zellij tab probe" autopilot-gate bullet wholesale with the
`pending_dispatches` mechanism (mint `Dispatched` on launch, suppression
arm reads the projection, `DispatchExpired` TTL sweep on the 60s heartbeat,
discharge-on-bind, close-by-tab-id reap), preserving the gate-bullet voice
(end with why the gate exists / what its firing means). In README.md:
revise the eighth-worker paragraph (dedup description, `ExecBackend`
`closeByName`→`closeByTabId`, the `autoclose_windows` reap line) and add an
"As of schema v50 (fn-N)" changelog paragraph matching the established
per-version narrative style.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md:62 — sole-writer synthetic-event list
- CLAUDE.md:349 — fn-674 autopilot-gate bullet (replace wholesale)
- README.md:1316 — eighth-worker paragraph (dedup / ExecBackend / autoclose reap)
- README.md:1151 — schema changelog block (add v50 paragraph)

### Risks

- Stale fn-674 name-oracle rationale surviving in either doc as contradictory guidance.

### Test notes

`rg -n 'liveTabNames|tabExistsByName|liveTabKeys|closeByName' CLAUDE.md README.md`
returns only historical/changelog mentions, no current control-path guidance.

## Acceptance

- [ ] CLAUDE.md sole-writer list includes `Dispatched` / `DispatchExpired`
- [ ] CLAUDE.md fn-674 gate bullet replaced with the `pending_dispatches` mechanism; no stale name-oracle rationale
- [ ] README eighth-worker paragraph + an "As of schema v50" changelog paragraph updated
- [ ] No stale name-as-oracle control-path guidance remains in either doc

## Done summary

## Evidence
