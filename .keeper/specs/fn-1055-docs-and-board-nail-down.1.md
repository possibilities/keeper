## Description

**Size:** M
**Files:** README.md

### Approach

ONE pass over README.md, anchored by content (sibling epics shift line numbers before this dispatches). Four operations. (1) Add the builds-worker section among the worker prose, distilled from src/builds-worker.ts:1-49: keeperd's first outbound-HTTP producer; polls the local buildbot master REST API on a ~15s setTimeout-after-completion cadence with an in-flight skip flag (never setInterval); manual AbortController deadline (AbortSignal.timeout is buggy on Bun/macOS, oven-sh/bun#7512) combined with shutdown via AbortSignal.any; posts typed build-snapshot/build-deleted messages with MAIN as sole writer minting synthetic BuildSnapshot/BuildDeleted events into the builds projection; worker opens read-only openDb solely to seed the boot change-gate; every transient failure contained inside the loop (never fatalExit); builder disappearance is enumeration-gated (tombstone only from a successful builders enumeration, never a failed cycle). Repair the dangling "wired like the builds poller" cross-reference (currently near line 3146) to point at the new section. (2) Drop the worker ordinal scheme: rewrite the 13 "A <Nth> Worker thread is…" section leads to named prose ("The Agent Bus relay worker…"), fix the ~4 mid-prose ordinal cross-references (currently near 2033, 2341, 3691, 3764), and re-word the count-bearing summary lines (near 3928) number-free ("The workers are fully independent; main supervises them all"). LEAVE UNTOUCHED the parallel numbering axes (producer-worker counts near 3205/3210/3380, the @parcel/watcher member count near 3915) and unrelated ordinals (near 322, 272, 698) — they count different things and are internally consistent. (3) Add a keeper prompt paragraph (zero mentions exist): the snippet/bundle substrate engine behind `keeper prompt <verb>`, living at plugins/prompt (a Bun package, NOT a claude-plugin), routed in-process from the keeper binary. (4) Fix the two "plugin-armed chatctl bus" monitor-example mentions (currently near 2747, 2793) to name the live monitor (`keeper bus watch` / keeper-bus per plugins/keeper/monitors.json). Forward-facing wording throughout; prune fn-id provenance where touched.

### Investigation targets

**Required** (read before coding):
- src/builds-worker.ts:1-60 — the section's source of truth
- README.md — sweep for "Worker thread is", "worker below", "the fourteen", "builds poller", "chatctl" to build the definitive site inventory at dispatch time
- plugins/keeper/monitors.json — the live monitor example to cite

**Optional** (reference as needed):
- src/daemon.ts spawn sites — confirm the worker set the prose names is current

### Risks

- Over-reach into the parallel numbering axes or unrelated ordinals — the leave-untouched list above is the guard
- Under-reach: an ordinal cross-ref missed at dispatch time — the content sweep (not the cached line numbers) is authoritative

### Test notes

Docs-only; the proof is the grep sweep in Quick commands plus reading the modified sections aloud for dangling references. Record the final site inventory in Evidence.

## Acceptance

- [ ] builds-worker section present; dangling ref repaired; keeper prompt paragraph present
- [ ] Zero "Nth Worker thread" ordinals or ordinal cross-refs remain; parallel axes untouched; summary lines number-free
- [ ] Both chatctl monitor examples name the live bus monitor

## Done summary

## Evidence
