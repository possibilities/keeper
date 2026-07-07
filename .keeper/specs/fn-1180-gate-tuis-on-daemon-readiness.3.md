## Description

**Size:** M
**Files:** src/view-shell.ts, src/refold-progress.ts, cli/board.ts, cli/jobs.ts, cli/git.ts, cli/autopilot.ts, cli/builds.ts, CONTEXT.md, test/view-shell.test.ts, test/refold-progress.test.ts

### Approach

The shared view-shell harness gates live rendering on daemon readiness instead of
stopping its connecting indicator at the first painted frame. A new shell input
(mirror the noteCursor seam) is fed by each view's subscription wiring from the
subscribe client's transition callback plus the freshest boot header. While
un-ready in live mode, data frames are held — the freshest snapshot is retained but
nothing paints and no history frame mints — and the indicator paints on the
refreshLive overlay; on the flip to ready the indicator stops and the held frame
paints immediately. Indicator branches in precedence order: fold cursor behind head
renders "re-folding X%" with counts (fed from the wire header while connected, from
the sqlite re-fold poller while unreachable; the displayed percentage never
regresses within a run — clamp across source switches, fall back to spinner plus
counts on an unstable denominator); at head with git seed pending renders a
non-spinning "waiting for git seed: <roots>" (generic wording when the roots list
is empty); the residual catching-up window renders a plain spinner with a
"catching up…" label. Disconnect after a paint keeps the last frame with a
"reconnecting…" pill via the existing flashStatus / persistentBannerPill machinery,
flipping to the full indicator when the reconnect's first result reports catch-up
(immediate) or the disconnect outlasts a ~1.5s grace — a timer distinct from the
1500ms banner-restore flashTimer, and the lastBody clear on the disconnected
lifecycle event must not force a churn repaint during a gated window. Snapshot mode
keeps its flow and threads the freshest observed catch-up state (or null) into the
trailer via the envelope input. Frames mode never arms the overlay (preserve the
live-mode guards); during catch-up it emits exactly ONE loading record whose frame
text is a STATIC loading body with no ticking percentage, resuming normal data
frames on ready.

refold-progress: make ensureOpen retryable — a failed lazy open no longer latches
openFailed for the process lifetime (retry on a later poll; a modest cap or backoff
is acceptable); closed still short-circuits; poll() still never throws and returns
null on any failure.

The five harness TUIs (board, jobs, git, autopilot, builds) extend their existing
onBootStatus wiring and add the transition-callback wiring — a few lines each.
Add the "Catching up" glossary entry to CONTEXT.md in Event-sourcing core after
Drain: the daemon-reported not-ready window (boot gate un-flipped, fold cursor
behind the events head, or git surface unseeded) carried on the boot-status header,
during which reads are provisional and viewers gate to a loading indicator;
distinct from Drain, the folding mechanism that closes it. The entry rides this
task because its region was mid-merge at plan time.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (a sibling epic touches cli/board.ts — re-read before editing).*

**Required** (read before coding):
- src/view-shell.ts:578-672 — spinner state, formatRefoldLine, tick/arm/stop (the machinery this replaces)
- src/view-shell.ts:644-652 and :1001-1003 — the frameCount self-stop and arm gate being removed
- src/view-shell.ts:896-953 — emit paths (frames mode, live pushFrame, repaintLocal) where the hold hooks in
- src/view-shell.ts:955-1004 — emitLifecycle (disconnected lastBody clear, spinner arm) and :677-689 flashTimer
- src/refold-progress.ts:74-98 — ensureOpen openFailed latch
- cli/board.ts:1187-1189 — representative view wiring (siblings: cli/jobs.ts:1060, cli/git.ts:454, cli/autopilot.ts:1091, cli/builds.ts:371)

**Optional** (reference as needed):
- src/protocol.ts:106-122 — BootStatus sub-fields the branches read
- test/view-shell.test.ts — scripted fake-poller harness documented at the file head
- CONTEXT.md:48 — the Drain entry the new glossary line lands after

### Risks

- The disconnect grace interacts with the banner-flash timer and lifecycle events; keep the timers distinct or a flash restore can clobber the reconnecting pill.
- The frames-mode loading body must stay static — a ticking percentage in it mints a frame per tick.

### Test notes

Fake refold poller plus synthetic boot payloads through the new input; fake timers
for the grace. Cover: gated first result paints nothing but the indicator; flip
paints the held frame immediately; git-seed branch with and without roots;
percentage monotonic across the poller-to-wire switch; disconnect shows the pill,
grace expiry flips to the indicator, a sub-grace reconnect never flickers; a
reconnect reporting catch-up flips immediately; frames mode emits one loading
record then resumes; a failed poller open retries on a later poll.

## Acceptance

- [ ] A harness TUI receiving catch-up-reporting results renders only the loading indicator, choosing the correct branch by precedence, and paints the held data frame immediately when readiness clears
- [ ] After a first paint, a socket drop shows a reconnecting pill holding the last frame, flipping to the loading indicator on grace expiry or immediately when the reconnect reports catch-up, and a sub-grace reconnect never flickers
- [ ] The displayed re-fold percentage never decreases within a run, including across the poller-to-wire source switch
- [ ] A failed re-fold-poller open retries on a later poll instead of disabling progress for the process lifetime
- [ ] Frames mode emits exactly one catch-up loading record and no spinner flood; snapshot mode still terminates and stamps the observed state
- [ ] All five harness TUIs wire the new inputs, and CONTEXT.md gains the Catching up entry

## Done summary

## Evidence
