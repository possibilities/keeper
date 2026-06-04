## Overview

A busy autopilot zellij session (20–30 panes) throughput-starves the single
zellij server thread: ~5940 `GetPaneRunningCommand timed out for plugin N`
across all panes, plus `Action … did not complete within 1s`. Tabs freeze
then "eventually catch up." Root cause is in code keeper owns, not zellij.
This epic lands the near-certain producer fix and durable tracing to
diagnose a suspected amplifying feedback loop. The actual loop fix is
DELIBERATELY out of scope — it will be planned from the trace data after
delivery.

## Quick commands

- `cd plugin/zellij-bridge && cargo test` — diff-fn + existing build_lines unit tests
- `bun run build:plugin` — regenerate the committed wasm (run on a binaryen-present box)
- `ls -la ~/.local/state/keeper/zellij-events/*.ndjson` — feed should stop growing on a quiescent-but-busy session (was 20MB/30min)
- `KEEPER_TRACE_TABNAMER=1 KEEPER_TRACE_ZELLIJ=1 keeperd` — watch stderr for rename/kick + notification/mint rates

## Acceptance

- [ ] Bridge plugin emits a pane line only when its `(tab_id, tab_name)` changed since last emit; a no-change event performs zero file I/O
- [ ] Per-event I/O collapses to one open + one batched `write_all` + one flush (was per-line open/flush/close)
- [ ] ndjson feed growth on a busy session drops by orders of magnitude vs the 20MB/30min baseline
- [ ] Env-gated tracing (`KEEPER_TRACE_TABNAMER` / `KEEPER_TRACE_ZELLIJ`) reports rename shell-outs, kicks, notification-posts, and actual data_version-bumping mints — zero cost when off
- [ ] No regression: consumer contract, seq monotonicity, O_APPEND #5177 contract, plugin_start sentinel, and `rename_re_emit_changes_tab_name` all intact

## Early proof point

Task that proves the approach: `.1` (bridge diff-before-emit). If the ndjson
feed stops growing on a quiescent busy session while tab renames still
propagate, the producer fix is proven. If it fails (e.g. PaneUpdate churn is
irreducible), fall back to the `ZellijWorker` off-hot-path I/O offload
(heavier; practice-scout flagged it as the next lever).

## References

- `.planctl/specs/fn-684-zellij-event-bridge-plugin{,.1,.3,.4,.5}.md` — original bridge tasks + invariants (seq/epoch/sentinel, O_APPEND #5177)
- `src/server-worker.ts:326-372` — canonical `KEEPER_TRACE_SERVER` env-gated trace convention to mirror
- `src/daemon.ts:876-911` — `BackendExecSnapshot` mint = the actual `data_version` bump site (worker has no DB by design)
- Overlap (advisory): fn-702 reads `src/zellij-events.ts:212` `parseZellijWatermarks`; this epic touches the PRODUCER (plugin) not the consumer parse, so no parse-shape change is intended.
- Zellij plugin docs: PaneUpdate is a full manifest snapshot every event; single-threaded server-side event loop; no bulk pane-query in 0.44.x

## Snippet context

No snippets/bundles attached. Searched scout mentions + `find-snippets` for
"atomic write", "env gated debug logging", "wasm plugin build", "ndjson seq
dedup" — repo-scout returned no snippet substrate; all conventions are
sourced directly from the files (server-worker trace pattern, build-plugin.sh,
zellij-events consumer).
