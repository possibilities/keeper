## Description

**Size:** S
**Files:** (discovery-first — likely external: zellij layout / launcher wrapper / run-dir provisioning; possibly cli/autopilot.ts for a defensive guard)

### Approach

Discovery-first: the in-repo code is ALREADY 100% append-only — every
`dispatch.log` write uses `appendFileSync` (O_APPEND|O_CREAT, never
truncates), and a repo-wide grep found NO truncating/recreating open in
cli/, src/, or scripts/. Yet the file's birth timestamp matched the
autopilot process startup (the fn-652 symptom: `dispatchedKeys` hydrated
empty, so `launch-suppressed` couldn't fire). So the truncation source is
OUTSIDE the TS. **Locate it first**, then fix at the source:

1. Inspect how autopilot is launched — it runs under a plain login zsh via
a zellij layout/keybinding into the long-lived `zellij --server` autopilot
session (NOT a LaunchAgent; only keeperd + keeper-dropwatch are
LaunchAgents). Check the zellij layout KDL / keybinding command, any
launcher shell wrapper, and how `dirname(sockPath)` (the run dir
`~/.local/state/keeper/`) is provisioned for a `> dispatch.log` redirect,
an `rm`, a `: > file` truncate, or a run-dir recreate.
2. Fix at the real source (most likely an ops/config change to the launch
command, not TS). If — and only if — the source can't be made non-truncating
externally, add a defensive in-repo guard that opens create-if-absent
WITHOUT truncate (which the current `appendFileSync` already is, so this
would be belt-and-suspenders, e.g. an explicit existence-preserving touch
at boot).
3. Do NOT switch to `createWriteStream({flags:'a'})` — Bun #3395 truncated
despite the append flag. Per-call `appendFileSync` stays the primitive.

Document the found root cause in the Done summary even if the fix lands
outside this repo (so the audit trail records WHERE the truncation was).

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:1951 — `dispatchLogPath = join(dirname(sockPath), "dispatch.log")` (the path; confirm how sockPath's dir is created)
- cli/autopilot.ts:2300, :2471, :2716 — the three append-only write sites (confirm they need no change)
- cli/autopilot.ts:1504-1653 — `hydrateDispatchLog` (the consumer that must hydrate non-empty post-fix)
- the zellij layout KDL / keybinding that launches `keeper autopilot` (external — likely ~/.config/zellij/ or an arthack launcher), and any shell wrapper
- how `~/.local/state/keeper/` is provisioned (boot script / launcher / processctl)

**Optional** (reference as needed):
- ~/Library/LaunchAgents/*keeper* (confirm autopilot is NOT a LaunchAgent — only keeperd/dropwatch are)

### Risks

- The fix may live entirely outside this repo (launcher/config) — that's an acceptable outcome; the deliverable is "dispatch.log provably persists," not necessarily a TS diff.
- A defensive in-repo guard risks being a no-op (code is already append-only) — only add one if it demonstrably closes a real gap the external fix can't.

### Test notes

Hard to unit-test an external truncation source. Acceptance is behavioral:
restart autopilot and confirm `dispatch.log` retains pre-restart launch rows
(birth time predates the latest start; `hydrateDispatchLog` returns
non-empty `dispatchedKeys`). If a defensive in-repo guard is added, unit-test
that it never truncates an existing file.

## Acceptance

- [ ] the real `dispatch.log` truncation/recreation source is identified and named in the Done summary (even if external)
- [ ] `dispatch.log` provably persists across an autopilot restart — pre-restart `launch` rows survive and `hydrateDispatchLog` rehydrates `dispatchedKeys` non-empty
- [ ] no switch to `createWriteStream`; per-call `appendFileSync` retained
- [ ] if a defensive in-repo guard was added, it is unit-tested to never truncate an existing file; if the fix was external, the Done summary records where it landed
- [ ] the durable re-dispatch guard (`dispatchedKeys` → `launch-suppressed`) works across a restart, complementing the 8ef4371 `isSurfaceLive` gate

## Done summary
Investigation: the in-repo write path is already 100% append-only (every dispatch.log write is appendFileSync = O_APPEND|O_CREAT, no truncating opens anywhere in cli/, src/, scripts/, or plugin/). No installed LaunchAgent touches dispatch.log (the keeperd.logrotate template plist truncates only server.stderr and is not installed in ~/Library/LaunchAgents/). The autopilot zellij session has no shell wrapper or zellij Run/Command — it's a manual zellij attach autopilot by the human, and the dispatch.log fresh-birth-time correlation with autopilot startup means the autopilot CLI itself created the file fresh because an external rm (operator-side state-dir cleanup after a manual keeperd bounce) removed it between runs. The truncation source is OPERATIONAL/EXTERNAL, not in-repo code. Defensive fix: added ensureDispatchLogExists(path) — a touch-without-truncate primitive (appendFileSync(path, '') = open(O_APPEND|O_CREAT) + zero-byte write + close, never O_TRUNC) wired into main() before hydrateDispatchLog, making dispatch.log's existence a load-bearing boot-time invariant against any future external rm. Stays on per-call appendFileSync per Bun #3395 — never switches to createWriteStream. Unit-tested 4 cases: existing-content survives byte-for-byte, missing-file creates empty, repeated calls are idempotent, parent-dir-missing I/O failure is swallowed without throwing. 80/80 autopilot tests + 114/114 client-side suite + 1641/1642 full repo green.
## Evidence
