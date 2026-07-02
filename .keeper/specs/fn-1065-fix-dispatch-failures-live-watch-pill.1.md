## Description

Fixes F1 (folds in F3's coverage). Evidence: src/collections.ts:601
DISPATCH_FAILURES_DESCRIPTOR declares pk: "verb" while the table identity
is (verb, id) and verb is a small class (work / close, per
src/daemon.ts:5732 and :5787). The live subscription keys by descriptor.pk
in three places - seedSubState watched/lastSent (src/server-worker.ts
~649/652), the selectVersionsByIds version map (src/collections.ts ~1020),
and the diff byId fan-out index (src/server-worker.ts ~2678) - so two live
rows sharing a verb collapse to one key and only one board --watch pill
emits. Give dispatch_failures a composite live identity (e.g. a synthetic
verb + " " + id wire key, or a descriptor composite-pk seam) so each
(verb, id) row tracks independently across seed / version-map / diff.
F3 (merged): the fix is unit-testable at the pure diff/version seam - a
descriptor-level test that two same-verb rows produce two tracked keys and
two patch frames - without booting a real subscription (test-isolation
rules forbid a live sub in-suite).

## Acceptance

- [ ] Two same-verb dispatch_failures rows each track as a distinct live
      key and each emit their own patch/pill on the watch path.
- [ ] Unit test at the pure diff/version seam covers the multi-same-verb case.
- [ ] Initial snapshot + status unchanged; no reducer/fold/RPC change.

## Done summary
Gave dispatch_failures a composite (verb, id) live-diff identity via an optional liveKeyColumns descriptor seam + liveKeyExpr/liveKeyOf helpers, routing seed/version-map/byId-fanout/membership-token through it so two same-verb rows each track and pill independently on board --watch. Byte-identical to pk for single-pk collections; no reducer/fold/RPC change. Covered by unit tests at the pure diff/version seam.
## Evidence
