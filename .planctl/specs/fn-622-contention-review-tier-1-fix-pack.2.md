## Description

**Size:** M
**Files:** `src/server-worker.ts`

### Approach

Add staged timing instrumentation to `runQuery`, `diffTick`, and `writeFrames`, gated by the same module-level `TRACE` const from task `.1`. Use `performance.now()` for sub-ms stage marks; `Date.now()` only for the wall-clock prefix on emitted lines. All emission goes through the existing `srvTs()` helper so the `if (TRACE) srvTs(...)` call-site gating discipline stays uniform.

Critical pattern for zero-overhead-when-off:

```ts
const t0 = TRACE ? performance.now() : 0;
// ... stage A ...
const t1 = TRACE ? performance.now() : 0;
// ... stage B ...
const t2 = TRACE ? performance.now() : 0;
if (TRACE) srvTs(`op=runQuery col=${col} ... countAndToken=${(t1-t0).toFixed(2)} pageSelect=${(t2-t1).toFixed(2)} ...`);
```

**Output format** (locked, awk-parseable, p50/p95/p99-aggregation-friendly): one line per emission, prefixed by the existing `[srv-ts] T=<epochMs>` shape, then `op=<name> col=<collection> rows=<N> bytes=<B>` keys, then each stage as `<stageName>=<ms>` with `.toFixed(2)` precision, terminated by `total=<ms>`. Stage names match the source-code call sites verbatim — no abbreviations:

- `runQuery`: `countAndToken pageSelect decodeRow frameEncode` (frame encode is the synchronous JSON-build at `src/server-worker.ts:502-509`; `writeFrames` byte count is emitted separately by `writeFrames`'s own instrumentation, see below)
- `diffTick`: `readWorldRev unionWatched selectByIds patchFanout metaCount` (decode pass is bundled inside `selectByIds` per `src/collections.ts:450` — single bracket is fine; do NOT crack open `selectByIds` for sub-stage timing)
- `writeFrames`: emits a separate line `op=writeFrames col=<col> bytes=<B> frames=<N>` when `buf.length >= KEEPER_TRACE_FRAME_BYTES` (default `4096`)

**Per-tick `diffTick` gating** mirrors the existing `pollLoop` sleep-overrun pattern at `src/server-worker.ts:1115-1138`: only emit a line when `TRACE && (anyStage > 5ms || total > 10ms)`. Without this gate, a 50 ms poll at rest produces ~1200 lines/minute with tracing on.

`runQuery` is called once per client query (rare relative to tick rate), so emit unconditionally when `TRACE=1` — no threshold gate needed there.

`KEEPER_TRACE_FRAME_BYTES` is read once at module load (alongside `TRACE`): `const TRACE_FRAME_BYTES = Number.parseInt(process.env.KEEPER_TRACE_FRAME_BYTES ?? "4096", 10);`. A non-numeric value falls back to the default.

### Investigation targets

**Required** (read before coding):
- `src/server-worker.ts:429-510` — `runQuery` body; map stages to call sites (countAndToken at 469-474, pageSelect at 489-491, decodeRow at 494, frameEncode at 502-509)
- `src/server-worker.ts:963-1095` — `diffTick`; map stages (readWorldRev at 988, unionWatched at 997, selectByIds at 1001, patchFanout at 1008-1032, metaCount second pass at 1067-1088)
- `src/server-worker.ts:842-865` — `writeFrames`; `buf.length` is the byte count, `frames.length` is the frame count
- `src/server-worker.ts:1115-1138` — `pollLoop` existing conditional-emit pattern to mirror
- `src/collections.ts:450` — `selectByIds` body; confirms decode is bundled inside (do NOT add a separate decode timer)

**Optional** (reference as needed):
- Bun `performance.now()` semantics — sub-ms resolution, not subject to timer coalescing
- Existing `[srv-ts] T=<epochMs> <event>` prefix shape in `srvTs` (line 135-137) — the new lines must keep it

### Risks

- **Stage timing becomes its own hot work.** Mitigated by ternary-guarded `performance.now()` — when `TRACE=0`, the const is `0` and no syscall fires.
- **Format drift between `runQuery` and `diffTick` outputs.** Mitigated by funneling both through one local helper `formatStages({op, col, rows?, bytes?, stages})` that returns the line string; both call sites then `if (TRACE) srvTs(formatStages(...))`.
- **Per-tick log floods during contention** (the exact event we're trying to study). Mitigated by the any-stage>5ms || total>10ms gate. If even that floods, the gate threshold can be raised via env (`KEEPER_TRACE_TICK_MS`); not in scope for this task — note as a future tuning knob.

### Test notes

- Test `runQuery` emission: open a real DB (test harness helper), with `KEEPER_TRACE_SERVER=1` confirm one `op=runQuery` line per query call; with TRACE unset confirm zero such lines.
- Test `diffTick` threshold gate: synthetic slow tick (mock `selectByIds` to sleep 6 ms) emits a line; fast tick (no sleep) does not.
- Test `writeFrames` byte threshold: write a small frame (no log), then a frame above 4 KB (logs `op=writeFrames bytes=<N>`).
- Verify zero-overhead-when-off: with `TRACE=0`, a microbenchmark of `runQuery` shows no measurable slowdown vs the pre-instrumentation baseline (10k iterations, < 1% delta). Document the bench result in `## Done summary` evidence.

## Acceptance

- [ ] `runQuery` emits `[srv-ts] T=<epochMs> op=runQuery col=<collection> rows=<N> bytes=<B> countAndToken=<ms> pageSelect=<ms> decodeRow=<ms> frameEncode=<ms> total=<ms>` per call when `TRACE=1`
- [ ] `diffTick` emits the analogous line per tick that crosses the threshold (`anyStage > 5ms || total > 10ms`); stages: `readWorldRev unionWatched selectByIds patchFanout metaCount total`
- [ ] `writeFrames` emits a separate `op=writeFrames col=<col> bytes=<B> frames=<N>` line when `buf.length >= KEEPER_TRACE_FRAME_BYTES` (default 4096) AND `TRACE=1`
- [ ] All stage values use `performance.now()` with `.toFixed(2)` precision
- [ ] When `TRACE=0`: zero `performance.now()` calls, zero `srvTs(...)` calls, zero allocations for stage timing
- [ ] One local `formatStages` helper funnels both `runQuery` and `diffTick` line construction
- [ ] `bun test` green
- [ ] Microbenchmark in `## Evidence` showing < 1% overhead with `TRACE=0`

## Done summary
Added staged timing instrumentation to runQuery/diffTick/writeFrames under the existing KEEPER_TRACE_SERVER gate. runQuery emits per call; diffTick gated to >5ms-any-stage or >10ms-total; writeFrames gated to KEEPER_TRACE_FRAME_BYTES (default 4096). Funneled through one formatStages helper for awk-parseable output. Zero-overhead-when-off verified via 10k-iter microbenchmark (TRACE=0 within noise of baseline).
## Evidence
