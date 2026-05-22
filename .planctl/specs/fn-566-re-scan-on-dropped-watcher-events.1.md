## Description

**Size:** M
**Files:** src/plan-worker.ts, src/transcript-worker.ts, test/plan-worker.test.ts, test/transcript-worker.test.ts, CLAUDE.md, README.md

### Approach

Add a drop-recovery handler to both producer workers' `@parcel/watcher`
subscribe callbacks. Today each callback does `if (err) { console.error(...);
return; }` — purely swallow-and-log. Change it to: on `err`, classify by
matching the substring `must be re-scanned` against the error message
(null-safe — read through `stringifyErr` or guard `err?.message`); on a match,
SCHEDULE a debounced re-scan instead of just returning; on a non-match, keep
today's swallow-and-log (do NOT change fatal/escalation behavior — additive
only).

The scheduler is net-new (no timer primitive exists in the repo): a
trailing-edge timer (~500ms) plus a single-flight guard (an `inFlight` flag and
a `pendingRescan` dirty bit — if a drop lands mid-scan, set the bit and re-run
once after). The re-scan body MUST reuse the existing change-gated boot-scan
primitive — `scanRoot(root, scanner)` for plan-worker (keyed PER-ROOT, since it
holds an array of subscriptions and each callback closes over its `root`) and
`scanJobsForTitles(db, stream)` for transcript-worker (single root; cheap,
bounded by live-job count). Reuse the warm in-memory `lastEmitted` change-gate
as-is (no DB re-seed) so a re-scan over unchanged files emits nothing. Wrap the
whole timer-callback body in try/catch → stderr so a re-scan throw is non-fatal
and never reaches `fatalExit`. The timer is an owned resource: clear it in each
worker's shutdown handler BEFORE `unsubscribe()`, and re-check `shuttingDown` at
the top of the timer callback so a queued scan can't touch a closing DB.

Critical: route transcript recovery through `scanFile`/`scanJobsForTitles`
(transient decoder, does NOT touch `pathState`), NEVER through `onChange` (which
advances/re-anchors byte offsets) — accidentally routing through `onChange`
would re-anchor tails and lose the recovered changes, the same failure mode as
re-subscribing.

Then update CLAUDE.md (six spots, per the epic Docs gaps) and README.md (two
spots) with the carve-out, following the existing `**Carve-out (V3)**` pattern.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:567-575 — the per-root subscribe-callback `err` swallow (edit site); the closure over `root` is the per-root debounce key
- src/plan-worker.ts:400 — `scanRoot(root, scanner)`, the change-gated re-scan primitive (boot-only today)
- src/plan-worker.ts:245,261,338 — `PlanScanner.lastEmitted` / `seed` / the `onChange` snapshot-dedup; the warm change-gate recovery reuses
- src/transcript-worker.ts:645-653 — the subscribe-callback `err` swallow (edit site); `db` + `stream` are in closure scope
- src/transcript-worker.ts:530 — `scanJobsForTitles(db, stream)`, the change-gated re-scan primitive (boot-only today)
- src/transcript-worker.ts:229 — `TranscriptLineStream.scanFile` (transient decoder; the correct recovery path) vs :341 `onChange` (offset-advancing; must NOT be the recovery path)
- src/transcript-worker.ts:165,177,326-329 — `lastEmitted` / `seedLastEmitted` / `scanFile` dedup

**Optional** (reference as needed):
- src/plan-worker.ts:604,613 — the unrecoverable `.catch` (subscribe-reject / addon-load) that stays fatal and UNTOUCHED
- src/transcript-worker.ts:698 — the equivalent unrecoverable `.catch`, untouched
- src/plan-worker.ts:530-547 / src/transcript-worker.ts:602-620 — shutdown handlers where the new timer is cleared before `unsubscribe()`
- node_modules/@parcel/watcher/index.d.ts — the `(err: Error | null, events: Event[])` callback signature

### Risks

- **Message-string coupling:** the only drop discriminator is the human-readable message text (no structured code) — couples to @parcel/watcher 2.5.6 wording. Mitigate with a unit test asserting the match against all three literal messages, and a stderr breadcrumb on every watcher `err` so a future wording change is observable.
- **Debounce feedback loop:** an un-debounced or leading-edge re-scan during a drop burst causes more UserDropped. Trailing-edge + single-flight is load-bearing, not cosmetic.
- **Shutdown race:** a pending timer firing after `unsubscribe()`/DB close would scan a closing connection — clearing the timer in shutdown + the `shuttingDown` re-check both guard this.
- **Deleted-during-drop staleness** (accepted, out of scope): `scanRoot` enumerates only existing files and never emits a delete, so a plan file removed during a drop window leaves a stale `epics`/`tasks` row until the next live touch — same blind spot boot scan has today.

### Test notes

Drive the pure cores with no Worker/watcher (the established three-tier pattern).
Clone the existing change-gate dedup tests: call the re-scan entry twice (boot +
simulated drop-recovery) over unchanged files and assert the second emits
nothing; then mutate a file and assert the recovery scan emits exactly the delta.
Unit-test the match predicate against all three literal drop messages plus a
non-matching err (asserts swallow, no scan). If the debounce/single-flight logic
is extracted into a small testable unit (timer injectable / fake-clock), test the
coalescing (N drops → 1 scan) and the in-flight dirty-bit re-run directly.

## Acceptance

- [ ] Both subscribe callbacks match `must be re-scanned` (null-safe) and schedule a re-scan; a non-matching err still swallows-and-logs unchanged
- [ ] plan-worker re-scan calls `scanRoot` for the affected root only (per-root keyed); transcript-worker re-scan calls `scanJobsForTitles` (routes through `scanFile`, never `onChange`)
- [ ] Re-scan is debounced (trailing-edge) and single-flight (in-flight flag + re-scan-again dirty bit); a burst of N drops collapses into one scan
- [ ] Re-running a re-scan over unchanged files emits zero synthetic messages (change-gate via warm `lastEmitted`); a changed file emits exactly its delta — covered by a unit test that scans twice
- [ ] The timer-callback body is try/catch → stderr; no recovery path throws out of the callback or reaches `fatalExit`; the unrecoverable `.catch` paths are untouched
- [ ] The timer is cleared in each shutdown handler before `unsubscribe()`, and the timer callback re-checks `shuttingDown` before scanning
- [ ] Unit tests cover: match against all three drop messages + a non-match; boot-then-recovery no-duplicate; recovery-emits-delta-on-change
- [ ] CLAUDE.md (module descriptions + the two "no in-process self-heal" spots + producer archetype + the "go look" carve-out) and README.md (non-goal bullet + producer paragraph) document the drop-recovery carve-out
- [ ] `bun test --isolate` passes

## Done summary

## Evidence
