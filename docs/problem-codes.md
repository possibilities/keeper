# Problem-code registry

The keeper-native CLI emits machine-matchable failure codes so an agent can
branch on `error.code` instead of scraping prose. Every `ok:false` envelope from
the shared helper (`cli/envelope.ts`) carries `error.{code, message, recovery}`;
the plan family's converged error sub-object carries
`error.{code, message, details, recovery}`. This file is the loadable registry:
for each code, what it means, the recovery contract, and whether a retry is safe.

The envelope shape and its exemptions live in `cli/envelope.ts`. `code` is
stable and never repurposed; `message` is corrective (never a stack trace or a
filesystem path); `recovery` is the actionable next step. New codes are added
here in the same change that introduces them.

## Daemon restart (`keeper daemon restart`)

The restart verb snapshots the served process identity and durable ledger marker,
asks launchd exactly once to restart the already bootstrapped keeperd job, then
requires one different identity to be ledger-backed, caught up, and unchanged for
at least twelve monotonic seconds. It never opens keeper.db or invokes a daemon RPC.
A refused socket while the old process releases its flock is transient; unreadable,
mismatched, unstable, or inconclusive evidence cannot succeed. Plist edits are a
different operation: use `launchctl bootout` plus `launchctl bootstrap`, not
`kickstart`.

| code | meaning | recovery | retry-safe |
| --- | --- | --- | --- |
| `kickstart-failed` | The one kickstart failed or timed out and the stronger replacement proof also remained incomplete. Bounded command and evidence diagnostics are retained. | Inspect launchd status, daemon stderr, and the evidence details. Reconcile the current daemon identity before another restart request. | conditional; reconcile first |
| `health-timeout` | The deadline ended before one replacement identity completed the full durability, Drain, health, and stabilization proof. | Inspect the evidence details and daemon stderr; fix the boot fault and reconcile the current daemon identity before retrying. | conditional; reconcile first |
| `restart-unproven` | Identity evidence was missing, unreadable, mismatched, unstable, or cancellation left it inconclusive. | Follow `error.details.evidence` to repair the specific evidence source, then reconcile the current daemon identity before another restart request. | conditional; reconcile first |
| `throttled-respawn` | The proof remained incomplete and bounded launchctl diagnostics reported throttling; launchctl text alone never proves success. | Inspect daemon stderr for the crash loop, fix it, and reconcile the current daemon identity before retrying. | conditional; fix and reconcile first |

## Shared-helper family (`keeper status`, `keeper query`)

These ride the `{schema_version, ok, error, data}` envelope on stdout. A bad
board / bad domain state is `data` at exit 0; only a transport or usage failure
is `ok:false` at exit 1, and the envelope still lands on stdout.

| code           | emitted by      | meaning                                                                                                                                                                           | recovery                                                                                            | retry-safe      |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------- |
| `unreachable`  | `keeper status` | The daemon did not answer within the bounded connect deadline (it is down or starting).                                                                                           | Confirm the daemon is running (its LaunchAgent restarts it), then retry.                            | yes (read-only) |
| `connect`      | `keeper status` | A connect / transport fault reaching the daemon socket, short of the deadline.                                                                                                    | Confirm the daemon and socket path, then retry.                                                     | yes (read-only) |
| `query_failed` | `keeper query`  | Any transport failure during a query round-trip: connect fail, response timeout, a daemon `error` frame, or a malformed / unexpected frame. `message` carries the specific cause. | Retry the read; a query is read-only and retry-safe. If it persists, confirm the daemon is running. | yes (read-only) |

Every code above is a read-path failure, so a retry never risks a double-mutate.

## Unified history, job reads, and foreground resume

`history list/show` read native Claude/Pi artifacts plus optional Keeper aliases.
`history search/files` also refresh the disposable private History index; index
maintenance mutates only that index. Native-only Sessions carry no Keeper
job/event/attribution rows. A shared Session reference never newest-collapses an
ambiguity.

| code                                                                                                                       | emitted by                            | meaning / recovery                                                                                                                                                                               | retry-safe                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `keeper_jobs_read_failed`                                                                                                  | `history list                         | show                                                                                                                                                                                             | search                                                                                            | files`, `history index refresh            | rebuild` | Keeper aliases could not be read safely. Confirm keeper.db health; use the specialist native `keeper transcript` reader when aliases are unavailable. | yes; no source mutation |
| `session_not_found`, `session_ambiguous`                                                                                   | `history show`, scoped `search/files` | The shared reference missed or stayed ambiguous. Run `keeper history list --format json`; retry with a qualified id, `--project`, and for `show` an exact `--artifact` when needed.              | yes; no source mutation                                                                           |
| `artifact_unavailable`, `unsupported_harness`, `read_failed`, `subagent_not_found`                                         | `history show`                        | The selected native artifact cannot be rendered or the specialist subagent selector missed. Choose a readable Claude/Pi artifact or a listed subagent.                                           | yes; no source mutation                                                                           |
| `index_refresh_failed`, `index_read_failed`                                                                                | `history search                       | files`                                                                                                                                                                                           | The private History index could not refresh or read. Retry or run `keeper history index rebuild`. | yes; refresh is idempotent and index-only |
| `invalid_fts_query`                                                                                                        | `history search --syntax fts`         | Raw FTS5 syntax is malformed. Revise it or use the default literal syntax. Empty and oversized queries are usage errors on stderr, not problem envelopes.                                        | yes                                                                                               |
| `index_operation_failed`                                                                                                   | `history index`                       | Status/refresh/rebuild/purge failed. Confirm owner permissions and History-index path availability, then retry; purge/rebuild remain safe because the index is disposable.                       | yes; index-only mutation                                                                          |
| `catalog_read_failed`, `keeper_jobs_unavailable`, `session_not_found`, `session_ambiguous`, `not_tracked`, `job_ambiguous` | `show-job <session-reference>`        | Catalog or job resolution failed honestly. Follow `error.recovery`; choose a qualified Session reference or exact job id, and use `keeper history show` for native-only history.                 | yes; read-only                                                                                    |
| `read_failed`, `not_found`, `ambiguous`                                                                                    | `show-job`                            | keeper.db could not be read, no job matched, or several job-only candidates remain. Narrow with exact `--job-id`, `--cwd`, or `--pane`; `--latest` applies only to an explicitly job-only query. | yes; read-only                                                                                    |

`keeper session terminate <session-reference>` resolves through the same catalog,
opens keeper.db read-only, and signals only an exact non-working process identity.
It never writes the database; each signal is preceded by a fresh pid, start-time,
and harness-command check.

| code                        | meaning / recovery                                                                                                                     | retry-safe              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `session_working`           | The resolved Session is working. Let it finish or stop; active work is never terminated.                                               | yes after state changes |
| `session_identity_unproven` | The pid-and-start-time witness is absent, malformed, changed, or unreadable. Refresh Session state; never signal an unconfirmed pid.   | yes with fresh evidence |
| `session_command_unowned`   | The identity-matching pid does not run the recorded Claude/Pi harness command. Inspect the stale or recycled record; do not signal it. | no until reconciled     |
| `session_signal_failed`     | TERM or KILL failed after the adjacent identity check. Check permissions and resolve the Session afresh before retrying.               | conditional             |

`session_working`'s refusal is structural, not incidental: a live Exclusive
file claim's holder is never signalled, so a peer blocked on that claim by
`keeper commit-work` (its `ownership_conflict` outcome, below) has no kill-based
out. The sanctioned cooperative path is the claimant voluntarily releasing the
contested paths — `keeper session release` — advised through the refusal
envelope's `request_release` pointer over one bounded, best-effort bus notice,
never a signal.

`keeper resume` returns before launch for `catalog_read_failed`,
`session_not_found`, `session_ambiguous`, `picker_cancelled`, `picker_invalid`,
`artifact_ambiguous`, `artifact_missing`, `artifact_unreadable`,
`artifact_identity_conflict`, `artifact_cwd_unresolved`, `cwd_vanished`,
`current_cwd_vanished`, `alias_conflict`, `unsupported_harness`, `session_live`,
and `wrong_cwd`. Follow `error.recovery`; `wrong_cwd` carries the shell-safe
re-entry command. `binary_not_found` and `launch_failed` identify native harness
startup failures—confirm no process started before retrying.

## Offline Session conversion (`keeper conversation convert`)

Conversion resolves an exact Claude or Pi Session reference, snapshots the selected native
artifact (plus Claude subagents), validates target-native files, then publishes without
replacing any destination. Human output uses the same codes as prose; `--format json`
carries them in the shared envelope. No failure includes transcript content.

| code                                                                                        | meaning / recovery                                                                                                                                                                                                                 | retry-safe                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `source_roots_unavailable`, `catalog_read_failed`                                           | The selected harness's native Session tree is absent, unreadable, or incomplete for title resolution. Check permissions and the relevant Claude `--config-dir` / Pi `PI_CODING_AGENT_DIR`, or use `--source-path <session.jsonl>`. | yes; no output prepared                                              |
| `source_not_found`, `source_ambiguous`                                                      | The exact native id/current-or-historical title missed or matched several Sessions. Correct the reference, add `--project`, or use `--source-path <session.jsonl>`.                                                                | yes; no output prepared                                              |
| `invalid_argument`, `source_not_regular`                                                    | The selected source is not a supported regular native Session transcript. Correct the path or invocation.                                                                                                                          | yes; no output prepared                                              |
| `source_read_failed`, `source_decode_failed`, `source_missing_final_lf`, `source_too_large` | The source cannot form one bounded, complete UTF-8 JSONL snapshot. Repair or finish the source artifact before retrying.                                                                                                           | yes; no output published                                             |
| `source_changed_during_read`                                                                | The source harness changed a Session file during the snapshot. Let the Session become idle and retry.                                                                                                                              | yes; no output published                                             |
| `validation_failed`                                                                         | The source cannot satisfy the direction's strict native graph/message contract. Preserve the source and report the artifact shape before retrying with corrected input or converter support.                                       | yes; no output published                                             |
| `publish_collision`                                                                         | A deterministic destination exists with different bytes or is not a regular private file. Choose another target root or remove only a verified stale conversion; Keeper never overwrites it.                                       | yes after resolving the collision; the conflicting path is untouched |
| `publish_failed`                                                                            | Private staging or no-clobber publication failed. Check ownership, permissions, and free space in the target root; invocation-owned partial outputs are removed.                                                                   | yes                                                                  |
| `conversion_failed`                                                                         | An unexpected converter fault occurred without exposing its diagnostic or transcript data. Preserve the source and report the command context.                                                                                     | conditional; inspect before repeated retries                         |

## Personal notes (`keeper note list|show`)

The finite Note readers use the shared envelope on stdout. `show --raw` emits the
exact body, while `show --preview` neutralizes terminal controls for fzf; a miss
still emits the failure envelope. The interactive `new` and `browse` workflows
report effect failures on stderr because they may already have preserved an
active Note.

| code                      | meaning                                               | recovery                                                                                  | retry-safe      |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `note_not_found`          | No Note matched the supplied id.                      | Choose an id from `keeper note list --state all` and retry.                               | yes (read-only) |
| `notes_store_unavailable` | The independent notes.db could not be opened or read. | Check the private Keeper state directory and retry; the failed read did not mutate Notes. | yes (read-only) |

## Autopilot control ops (`keeper autopilot pause|play|mode|arm|disarm|retry|config|worktree`)

Each control op round-trips one control RPC and rides the shared envelope. The
daemon's echoed result value is `data` (ok:true, exit 0); a server rejection,
transport fault, or unexpected frame is `ok:false` (exit 1) on stdout. A control
RPC MUTATES, so the transport-failure recovery is mutate-aware (a pre-send
connect failure is safe to retry; a mid-flight timeout may already have applied).
CLI-usage errors (bad args) stay on stderr at exit 1, off the envelope.

| code                   | meaning                                                                           | recovery                                                                                                                                                                                  | retry-safe        |
| ---------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `rpc_unreachable`      | The daemon did not answer the control RPC over its socket.                        | Confirm the daemon is running. A pre-send connect failure is safe to retry; a mid-flight timeout may have applied — re-read state (`keeper autopilot` / `keeper status`) before retrying. | conditional       |
| `rpc_rejected`         | The daemon rejected the RPC (its `error` frame code passes through when present). | Correct the request per the code, then retry — a rejected RPC did not mutate state.                                                                                                       | yes (not applied) |
| `rpc_unexpected_frame` | The daemon returned a frame type the control path did not expect.                 | Retry; if it persists, confirm the daemon and CLI are the same version.                                                                                                                   | conditional       |

## Autopilot withhold reasons

The reconciler's machine frame carries `withholds`, a replace-merge map keyed by
task or epic id. Each value is `{code, severity, detail}`. `code` is the stable,
bounded enum below; `detail` holds optional per-instance facts and is not a match
key. A target absent from the next map is no longer withheld. Stderr reports only
code transitions and rate-limits each target/code pair.

| code | meaning |
| --- | --- |
| `autopilot-paused` | Autopilot is paused. |
| `not-armed` | Armed mode excludes the target's epic from the armed dependency closure. |
| `merge-gate` | A required upstream lane has not landed in the local default branch. |
| `dispatch-in-flight` | This reconciler already has the same dispatch in flight. |
| `failed-key` | An open dispatch failure suppresses the target. |
| `claim-fence` | A durable, unreleased Dispatch claim owns the exact target. |
| `activity-collision` | Current Harness activity or a legacy occupying job conflicts with the target. |
| `live-tab` | A live managed tab covers the pre-SessionStart binding window. |
| `cooldown` | The fold-lag-safe redispatch cooldown is active. |
| `finalizer-guard` | The epic finalizer guard suppresses a duplicate close. |
| `data-bug-missing-cwd` | The task or epic has no effective launch cwd. This is the only `error`-severity withhold; repair the Plan's repo coordinates. |
| `budget-exhausted` | The current global dispatch budget has no remaining capacity. |

These are live decision reasons, not sticky failure codes and not Parked launches.
They mint no Event or Projection row.

## Tabs command family (`keeper tabs list|restore|dump`)

Crash-restore of keeper-managed agent windows, every read a daemon-down read-only
`keeper.db` open. `list` rides the shared `{schema_version, ok, error, data}`
envelope (generation summaries + the live set as `data` at exit 0; a keeper.db
read failure is `read_failed`, `ok:false`, exit 1, still on stdout). `restore` and
`dump` are NOT envelope commands — `restore` prints its plan/outcome text (a bad
board state is not a transport failure) and carries RICH exit codes so an
orchestrator can tell a policy refusal from a runtime failure; `dump` writes a
runnable bash script on stdout. The autopilot fail-closed gate on `restore --apply`
carries over verbatim (exit 1 while autopilot is UNPAUSED unless `--force`).

| code          | emitted by         | meaning                                                               | recovery                                                                                                     | retry-safe      |
| ------------- | ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| `read_failed` | `keeper tabs list` | keeper.db could not be opened / read for the generation-summary read. | Retry — the read opens keeper.db read-only and never mutates. If it persists, confirm the daemon is healthy. | yes (read-only) |

Exit codes (published in `keeper --help --json`, distinct from the usage code and
the await-owned range):

| exit | emitted by                    | meaning                                                                                                                                                                            |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | `keeper tabs restore`         | Refused a non-TTY AMBIGUOUS selection (the richest generation is not the freshest); the ranked table prints on stderr. Re-run with `--generation <id>` or on a TTY for the picker. |
| 7    | `keeper tabs restore --apply` | ZERO candidates without `--allow-empty`. Pass `--allow-empty` to proceed with an empty set, or drop `--apply` to inspect the plan.                                                 |
| 8    | `keeper tabs restore --apply` | PARTIAL launch failure — some candidates relaunched, some failed; the restored/failed summary prints on stdout. Re-run to retry the failures (already-live sessions are deduped).  |

## Agent provider matrix (`keeper agent providers resolve|check`)

The host-matrix doctor verbs read the REQUIRED `~/.config/keeper/matrix.yaml` v2
(ADR 0036) — the ordered provider roster that grows the worker model axis beyond
claude. They emit a structured JSON line on stdout (`resolve`'s candidate
envelope, `check`'s findings) and human diagnostics on stderr; neither rides the
shared `cli/envelope.ts` shape. Reads only; nothing is mutated.

`resolve <model> <effort>` emits `{schema_version, model, effort, driver,
candidates:[{harness, model_id, preset_name}], defaults}` at exit 0. On the
unroutable path it emits `{schema_version, error:"no_route", model, effort,
driver, candidates:[]}`. An ABSENT matrix is a typed loud failure (exit 2, ADR 0036) naming the state and the copy-the-example fix — there is no claude-native
fallback candidate.

`check` emits `{schema_version, matrix_present, findings:[...]}`; an ABSENT matrix
reports `matrix_present: false` with an empty finding list at exit 0 — nothing to
drift-check yet, distinct from `resolve`'s loud absent-matrix failure above. Each
finding is a `binary-unreachable` (a provider whose harness binary is off PATH), an
`off-cube-triple` (a well-formed host launch triple — a `<harness>_default`, a
per-verb `dispatch:` row, or a panel member — outside the enumerable cube, tagged
with its `source`), or a `malformed-triple` (a host triple the grammar rejects,
carrying its `source` + `error`). The auto-generated `<provider>-<model>`
preset-collision finding retires with the named catalog (ADR 0033).

| code       | verb                      | meaning                                                                                       | recovery                                                                                  | retry-safe      |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `no_route` | `agent providers resolve` | A wrapped (non-claude) model has no configured provider in the roster (empty candidate list). | Add a provider serving the model to `~/.config/keeper/matrix.yaml`, or correct the token. | yes (read-only) |

`check`'s host-triple findings are lints over `presets.yaml`'s `dispatch:` per-verb
table (ADR 0040) and `panel.yaml`'s members. Every `dispatch:` row that resolves a
non-null triple is checked; an unset row simply contributes no finding (it floors to
the compiled-in default at dispatch time, never a drift target here).

| kind                 | `source` examples                                                           | meaning                                                                                                | recovery                                                                                     | retry-safe      |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------- |
| `binary-unreachable` | (none — carries `provider`/`binary`)                                        | A roster provider's harness binary is off PATH.                                                        | Install the missing binary, or drop the provider from `matrix.yaml`.                         | yes (read-only) |
| `off-cube-triple`    | `claude_default`, `dispatch.work`, `dispatch.unblock`, `panel 'x' member 1` | A well-formed `<harness>::<model>::<effort>` triple names a combination the roster does not enumerate. | Correct the triple in `presets.yaml`/`panel.yaml`, or add the model/effort to `matrix.yaml`. | yes (read-only) |
| `malformed-triple`   | `dispatch.close`, `pi_default`, `panel 'x' member 2`                        | A host triple fails the `<harness>::<model>::<effort>` grammar (tool fault, not drift).                | Fix the triple's syntax in `presets.yaml`/`panel.yaml`.                                      | yes (read-only) |

Exit codes (distinct from the shared 0/1/2 core, published in `keeper --help --json`):

| exit | verb                      | meaning                                                                                                                                                                                                                                         |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | `agent providers resolve` | A model/effort token violates the name charset (lowercase alnum, hyphen, underscore, dot; no leading dot), or the matrix is malformed.                                                                                                          |
| 3    | `agent providers resolve` | `no_route` — a wrapped model has no configured provider in the roster. Add a serving provider or correct the model token.                                                                                                                       |
| 1    | `agent providers check`   | Tool fault — the matrix is malformed (ConfigError naming the offense on stderr), OR a host launch triple is malformed (the grammar rejects a `<harness>_default` / `dispatch:` verb row / panel member); each malformed triple prints one line. |
| 9    | `agent providers check`   | One or more roster/host-triple/reachability drift findings (an unreachable provider binary, or a well-formed host launch triple outside the enumerable cube); each finding prints one line.                                                     |

## Panel-run lifecycle

`keeper agent panel` uses a durable run manifest rather than the shared CLI envelope. The manifest's
`request_id` is the ownership key; reissuing `start` with the same run directory and byte-identical
arguments joins the reservation without another fan-out. A digest mismatch, cancellation tombstone,
or member attempt beyond the explicit resume cap is not retryable under a fresh identity. `resume` is
the only bounded recovery operation and applies only to positively dead, nonterminal attempts.

The panel runner emits one of two first-line sentinels: `PANEL_ANSWER` or `PANEL_RUN_FAILED`. A failed
quorum, exhausted wait backstop, unusable judge return, or judge cancellation is
`PANEL_RUN_FAILED`; neither the member fan-out nor the judge is automatically retried. `wait` exit 124
means only that its polling chunk elapsed and is safe to repeat against the same `run_dir`.

| state / token      | meaning                                                                                                                                                                                                            | recovery                                                                                                                                                                                                                                                                                                      | retry-safe                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `cancelled`        | The cancellation tombstone was persisted and every registered member identity settled.                                                                                                                             | Inspect retained outputs if needed; start a deliberately new request only for a new invocation.                                                                                                                                                                                                               | no (the request is terminal)     |
| `cleanup_failed`   | The latest bounded pass could not prove one or more exact `member#attempt` resources absent; `unresolved_cleanup` lists them, each failed attempt retains a bounded `cleanup_error`, and success remains withheld. | Daemon maintenance automatically retries pending and failed cleanup from the durable canonical controls. If an identity remains, inspect its manifest diagnostic and run-directory control for access, shape, ownership, or teardown faults; never derive a replacement target or use broad process matching. | yes (automatic, bounded cadence) |
| `no_message`       | A member terminated without a usable answer. It counts as a failed leg for quorum.                                                                                                                                 | Let the content-blind quorum decide the request; do not relaunch the leg implicitly.                                                                                                                                                                                                                          | no automatic retry               |
| `PANEL_RUN_FAILED` | The owned runner reached a terminal failure and produced no panel answer.                                                                                                                                          | Use its one-line reason and run directory to inspect the reservation. A later intentional inquiry needs a new request identity.                                                                                                                                                                               | no automatic retry               |

## Worker-cell launch rejects (`keeper dispatch`, autopilot)

The launcher-owned worker-cell seam (`src/worker-cell.ts`) rejects a doomed
`work` launch BEFORE spawning: the autopilot producer mints a sticky
`DispatchFailed` (cleared by `retry_dispatch`), and manual `keeper dispatch` dies
non-zero (exit 1) with the same reason. These are launch-time reason tokens
(carried in the sticky reason / stderr message), NOT shared-envelope codes. The
shared precedence is bad matrix → provider translation reject → invalid cell →
provider launch-contract reject → missing manifest → stale cohort → shadowed
plugin → launch.

| code                                 | emitted by                     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                           | recovery                                                                                                                                                                                                                                                         | retry-safe                           |
| ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `worker-cell-bad-matrix`             | autopilot producer, `dispatch` | The host worker matrix (`~/.config/keeper/matrix.yaml`) failed to load — one of four states the reason NAMES: `absent` (no file), `unparseable` (bad YAML / unreadable), `schema-invalid` (a shape violation — e.g. a retired `route:`/`native:`/`name:`/`subagents:` key), or `valid-but-empty` (an empty file). No cell can compose, so the daemon parks every cell-bearing `work` dispatch behind this sticky and never exits. | Copy `docs/examples/matrix.example.yaml` to `~/.config/keeper/matrix.yaml` and edit it (the message names the exact path + fix), then `keeper retry-dispatch` (autopilot) / re-run (manual).                                                                     | yes (fix config first)               |
| `worker-cell-invalid`                | autopilot producer, `dispatch` | The task's effective `{model, tier}` pair is outside the live matrix's ragged worker-cell axes, so no cell path can be selected.                                                                                                                                                                                                                                                                                                  | Correct the task assignment or matrix, compile the cohort, then `keeper retry-dispatch` / re-run.                                                                                                                                                                | yes (fix assignment or matrix first) |
| `worker-cell-missing`                | autopilot producer, `dispatch` | The selected cell's `.claude-plugin/plugin.json` is absent. Claude would infer the directory basename instead of loading the constant `work:worker`, so launch is refused before any session starts.                                                                                                                                                                                                                              | Run `keeper prompt compile --role work:worker --target claude`, then `keeper retry-dispatch` / re-run.                                                                                                                                                           | yes                                  |
| `worker-cell-stale`                  | autopilot producer, `dispatch` | A selected manifest exists, but the compiler-owned cohort fails its current source fingerprint, canonical inventory, hash/sidecar verification, or exact selected-cell membership check. Runtime verification is read-only and never repairs silently.                                                                                                                                                                            | Run `keeper prompt compile --role work:worker --target claude`; use the same command with `--check` to verify, then `keeper retry-dispatch` / re-run.                                                                                                            | yes                                  |
| `work-plugin-shadowed`               | autopilot producer, `dispatch` | Another preloaded plugin claims the `work` name. Only the selected cell's exact physical directory is legitimate; configured hard plugins, active scan results, cwd plugins, and sibling worker cells are all rejected when they would steal `work:worker`.                                                                                                                                                                       | Remove or rename the named plugin, or enable `worker_plugin_isolation: strip-scan-dirs` when the collision comes only from `plugin_scan_dirs`; then `keeper retry-dispatch` / re-run.                                                                            | yes (fix plugin composition first)   |
| `worker-provider-no-map-entry`       | autopilot producer, `dispatch` | The `worker_provider` constraint must translate this cell's assignment into the required family, but the cross-provider equivalence map has NO entry in that direction. The reason NAMES the assigned cell + direction. Fail-closed — the constraint NEVER falls back to the assigned provider.                                                                                                                                   | Add the mapping to `plugins/plan/provider-equivalence.yaml` (re-run `bun plugins/plan/scripts/model-guidance-check.ts --check`), then `keeper retry-dispatch` (autopilot) / re-run (manual) — OR clear the constraint (`keeper autopilot config worker_provider none`). | yes (fix map or clear constraint)    |
| `worker-provider-target-not-on-host` | autopilot producer, `dispatch` | The map's entry translated the assigned cell to a target cell that is NOT a dispatchable cell on the live host matrix (target model or its effort absent). The reason NAMES the assigned + mapped cell + direction. Fail-closed — no fallback.                                                                                                                                                                                    | Fix the map target (or add the target cell to `matrix.yaml`'s `subagent_models`/efforts), then `keeper retry-dispatch` / re-run — OR clear the constraint.                                                                                                       | yes (fix matrix or clear constraint) |
| `worker-provider-map-malformed`      | autopilot producer, `dispatch` | The `worker_provider` constraint is set but `provider-equivalence.yaml` failed to load/parse at dispatch (the drift gate is offline). The reason NAMES the assigned cell + direction + the parse detail. Fail-closed PER CELL — a stale map parks dispatch, never crashes the cycle.                                                                                                                                              | Fix `plugins/plan/provider-equivalence.yaml` (re-run the `--check` drift gate), then `keeper retry-dispatch` / re-run — OR clear the constraint.                                                                                                                 | yes (fix map or clear constraint)    |
| `worker-provider-cell-unlaunchable`  | autopilot producer             | The effective `{model, tier}` cannot jointly satisfy its active Provider constraint, rendered driver, launchable route, and wrapped marker. This includes a GPT-constrained cell that resolves native-only, a route-less wrapped cell, and a marker that disagrees with the route. The reason NAMES the constraint and effective cell pair.                                                                                 | Reconcile the Provider constraint, equivalence target, and host-matrix route; compile the selected worker cohort when needed, then `keeper retry-dispatch`.                                                                                                    | yes (fix joint launch contract)      |
| `parked-launch`                      | autopilot producer             | A fired Dispatch attempt remains pending without a Harness session beyond the launch grace: parked or slow, inspect the window. The sticky names that tmux window and suppresses re-serve without killing or closing it.                                                                                                                                                          | Inspect the named window. A late SessionStart bind clears the sticky automatically; otherwise resolve or close the parked wrapper, then `keeper retry-dispatch`.                                                                                              | yes (inspect the window first)       |

Distinct from the run-time `no_route` the `agent providers resolve` verb emits
(above): that is a read-time doctor verdict, this is a launch-time dispatch
reject that parks the task.

The `worker-provider-*` rejects surface only while
`autopilot_state.worker_provider` carries a Provider constraint (`claude`/`gpt`).
The translation rejects cover equivalence-map totality; the producer-only launch-contract
reject re-proves that the translated or same-family effective cell has a compatible route
and marker. Together they make an impossible constrained cell visible as a sticky rather
than silently starving the board, falling back to the wrong family, or starting a worker
whose guard can never permit its contract.

## Lifecycle evidence diagnostics

`bun scripts/audit-session-activity.ts --db <snapshot> --limit <n>` is the offline, read-only view of
Harness activity, Dispatch attempts, Dispatch claims, and their classification deltas. Its reasons are diagnostic
values, not shared-envelope codes. Follow up by identifier; never infer activity from a pane, pid, path,
or title alone.

| output / reason                                                                        | meaning                                                                                                                                                                                             | recovery                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child-evidence-incomplete`, `resource-evidence-incomplete`, `parent-state-incomplete` | Harness activity is `unknown` because required projected evidence is absent, malformed, or contradictory. Capacity, conflicting dispatch, autoclose, finalize, and destructive cleanup fail closed. | Check projection health and the named session's recent lifecycle events. Repair the producer or replay a dead letter when one is present, then take a fresh snapshot; do not force the session quiescent.                                       |
| `child-evidence-stale`, `resource-evidence-stale`                                      | An open child or work-bearing resource has not supplied freshness evidence, so elapsed time cannot prove idle.                                                                                      | Confirm the exact child/resource identity. If it is live, restore its event producer; if positively dead, let the normal exit/reconcile path record terminal evidence. Re-run the audit on a fresh snapshot.                                    |
| `stale_attempts` / `stale-pending`                                                     | An unbound Dispatch attempt exceeded its launch-window ceiling, either as a surviving pending launch or as an orphaned claim whose durable Dispatch claim outlived the ephemeral pending row across a crash. A delayed start gains no authority unless its exact attempt identity still owns the current claim. | Inspect the target's `dispatch_claims`, any surviving `pending_dispatches` row, and its dispatch-failure row. Let the pending sweep or orphaned-claim Reaper expire and fence the exact attempt; retry a Sticky only after confirming no current exact Dispatch claim or live activity owns the target. |
| provisional or absent cut/clean settlement                                             | Provider transcript evidence has not crossed its terminal settlement boundary. An intermediate cut cannot stop the parent or unlock lifecycle consumers.                                            | Preserve the complete transcript tail and restore the transcript worker/read path. A later clean terminal record settles the same invocation; a torn partial line is ignored rather than repaired by hand.                                      |
| `legacy-unfenced`                                                                      | The session has no exact Dispatch attempt identity. It may still carry Harness activity and a Resource hold, but cannot acquire or consume a newer exact Dispatch claim.                            | Let the session reach a positive terminal boundary. Use a fresh exact attempt for later dispatch; do not assign a guessed attempt id to the legacy row.                                                                                         |

## Provider-leg cascade diagnostics

The durable leg cascade parks an owned Provider leg and retains its wrapper
attempt's exact Dispatch claim when termination cannot be proved safe or
complete. These `blocked_reason` values are Operator jams with a page-once
incident marker; a later positive probe can clear a recoverable block without
releasing first.

| blocked reason | meaning | recovery | retry-safe |
| --- | --- | --- | --- |
| `identity-unknown` | The recorded pid/start-time identity or close-recycle corroboration is incomplete. | Restore process and tmux probe health, then let the level-triggered cascade re-probe; never signal or release from partial identity. | yes (automatic read retry) |
| `command-unowned` | The identity-matching pid no longer runs the recorded Provider harness command. | Inspect the exact leg identity and launcher evidence; do not signal the replacement process or force-release its claim. | no until reconciled |
| `kill-unconfirmed` | The bounded KILL attempt cap was reached without the leg's folded terminal event or a recycle-safe gone observation. | Restore terminal-event/process evidence and let the cascade confirm exit; there is no force-release path. | conditional |
| `signal-failed` | TERM or KILL failed after the adjacent exact-identity recheck. | Check same-user permissions and process state; the next level-triggered pass re-probes before any further signal. | conditional |

A degraded, empty, generation-unknown, moved, split, or dead-pane tmux sweep
defers owned window cleanup without targeting a title. A positively absent pane
or canonical generation mismatch converges without touching the replacement.
The claim remains held until the birth-captured coordinate either passes every
destructive gate or is positively absent/recycled.

## Resource cleanup diagnostics

Autoclose and worktree teardown fail closed when exact Resource hold identity cannot be re-proved. These
reason prefixes are operator-visible diagnostics, not shared-envelope codes.

| reason prefix                                                    | meaning                                                                                                                          | recovery                                                                                                                                               | retry-safe                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `worktree-finalize-cleanup-conflict`                             | The recorded lane path is registered to a different branch or no longer proves keeper lane ownership. Keeper will not remove it. | Inspect the named worktree and owner; remove or relocate the replacement only if intentional. The next reconcile retries from fresh identity evidence. | yes (after identity is reconciled) |
| `resource-generation-unknown` / `resource-generation-unobserved` | The tmux probe did not provide a canonical generation matching the recorded Resource hold. Cleanup remains deferred.             | Restore tmux probe health and let the next pulse re-observe it; do not delete by pane id or path manually.                                             | yes (automatic read retry)         |
| `resource-generation-mismatch`                                   | The pane id now belongs to another tmux server generation. The old cleanup intent is fenced and cannot target it.                | Leave the replacement pane alone. Keeper retries only after current projection evidence settles.                                                       | yes (automatic read retry)         |

A live plan session whose cwd vanished remains the separate detect-only `stuck-sentinel: cwd-missing`
condition: it pages for operator diagnosis and never authorizes `StopReconciled`, pane kill, or lane
removal.

## Wrapped-delegation advisory (autopilot producer)

A wrapped-cell `work` dispatch (its effective model not served natively by
claude) carries the `KEEPER_WRAPPED_ENVELOPE` marker naming where its provider
leg must write a result envelope. Every reconcile cycle the producer stats that
path for each DONE wrapped-cell task and, when it's absent, logs a coalesced
advisory line — evidence the wrapper implemented natively instead of
delegating. DETECT-ONLY: it never blocks a dispatch and mints no
`dispatch_failures` sticky, so there is nothing to `retry_dispatch`.

| code                         | emitted by         | meaning                                                                                                                                                                                                     | recovery                                                                                                                                                                               | retry-safe                |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `wrapped-delegation-skipped` | autopilot producer | A wrapped-cell task done-stamped with no provider-leg result envelope at its `KEEPER_WRAPPED_ENVELOPE` path — advisory evidence the wrapper skipped delegation and implemented with claude tokens directly. | Advisory only — inspect the task's commit; no dispatch to retry. Clears itself once a later task's envelope lands, or the line simply stops recurring once the coalesce window lapses. | n/a (advisory, no sticky) |

The line prints on the daemon's stderr (`~/.local/state/keeper/server.stderr`
by default, per the LaunchAgent plist) — `grep 'wrapped-delegation-skipped'`
there to find flagged tasks.

## Plan family (`keeper plan` accumulate-all failures)

`plugins/plan/src/emit.ts::emitFailureEnvelope` prints
`{"success": false, "error": {code, message, details, recovery}}` (the plan
`emit()` family is exempt from the shared envelope for Python byte-parity and the
one-JSON-root guard — it converges only on this error sub-object). `details` is a
string list of every issue found; `recovery` is resolved from the code registry
in `emit.ts` (`recoveryForPlanCode`, fallback for an unlisted code). Most are
input-validation failures surfaced BEFORE any commit, so re-running after fixing
the input is always safe. The family also carries one commit-time RETRYABLE
class, `merge_in_progress`: a mutating verb refuses when the state repo is
mid-operation — it wrote nothing and no input is wrong, so re-running unchanged
once the operation clears is the whole recovery.

| code                 | meaning                                                                                                                                                                                                                                                                                                                | recovery                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bad_yaml`           | The scaffold / refine YAML is malformed.                                                                                                                                                                                                                                                                               | Fix the reported parse or shape error in the input and re-run.                                                   |
| `brief_missing`      | `apply-selection` found no selection brief on disk for the epic, or the brief's `from_followup` flag does not match the invocation.                                                                                                                                                                                    | Run `keeper plan selection-brief <epic_id>` (add `--from-followup` for a follow-up) before applying the verdict. |
| `cell_invalid`       | An `assign-cells` or `apply-selection` cell set is invalid: an out-of-axis tier/model, or an unknown, duplicate, missing, or non-todo task id (the full-set + todo-only contract), including a brief-vs-live axis divergence detected at `apply-selection` apply time.                                                 | Correct the cells so every todo task of the epic is covered exactly once with in-axis values, then re-run.       |
| `dep_cycle`          | The task dependency graph has a cycle.                                                                                                                                                                                                                                                                                 | Break the cycle among the listed tasks, then re-run.                                                             |
| `dep_invalid`        | A declared task dependency does not resolve.                                                                                                                                                                                                                                                                           | Correct the referenced task id (or remove the edge) and re-run.                                                  |
| `epic_dep_invalid`   | A declared epic dependency does not resolve.                                                                                                                                                                                                                                                                           | Correct the referenced epic id (or remove the edge) and re-run.                                                  |
| `duplicate_epic`     | An epic with this slug already exists.                                                                                                                                                                                                                                                                                 | Choose a distinct slug, or pass `--allow-duplicate` to create a sibling.                                         |
| `id_collision`       | A generated id collides with an existing artifact.                                                                                                                                                                                                                                                                     | Re-run with a distinct slug or id.                                                                               |
| `integrity_failed`   | The post-write integrity check failed; nothing was committed.                                                                                                                                                                                                                                                          | Re-run the verb; if it persists, inspect the reported artifacts.                                                 |
| `merge_in_progress`  | Commit-time RETRYABLE: the state repo is mid-operation — a merge / cherry-pick / revert / rebase / sequencer (the one keeper's own machinery creates is a merge), OR the shared commit-work lock is held by a concurrent commit / base-merge past the deadline. `details` names the operation. The verb wrote nothing. | Wait for the operation to finish, then re-run the verb unchanged — no input fix needed.                          |
| `target_invalid`     | The target id is not well-formed or does not exist.                                                                                                                                                                                                                                                                    | Correct the target and re-run.                                                                                   |
| `spec_invalid`       | A task or epic spec field is missing or malformed.                                                                                                                                                                                                                                                                     | Fix the reported spec field and re-run.                                                                          |
| `model_invalid`      | The declared model is not recognized.                                                                                                                                                                                                                                                                                  | Set a supported model value and re-run.                                                                          |
| `tier_invalid`       | The declared tier is out of range.                                                                                                                                                                                                                                                                                     | Set a supported tier value and re-run.                                                                           |
| `repo_invalid`       | The repo path is not a valid git repo root.                                                                                                                                                                                                                                                                            | Correct the repo path and re-run.                                                                                |
| `missing_session_id` | No session id is available for a mutating verb.                                                                                                                                                                                                                                                                        | Ensure the invocation carries a session id and re-run.                                                           |
| `verdict_invalid`    | An `apply-selection` selector verdict is malformed: unparseable JSON, an error-shaped `{"error": ...}` return, an unknown top-level key, or a cell out of the brief's candidate axes or coverage (also the `--degraded` + `--from-followup` combination).                                                              | Fix every issue listed in `error.details` and re-pipe the verdict on stdin.                                      |
| _(unlisted)_         | Any other accumulate-all failure code.                                                                                                                                                                                                                                                                                 | Fix the reported problems in the input and re-run; `details` lists them.                                         |

### Selection-audit verbs (`selection-audit-brief`, `selection-review-submit`)

`selection-audit-brief` is the mechanical, commit-only capture beat `/plan:close`
runs before the irreversible `epic close`; `selection-review-submit` is the
separate write path a later out-of-band grading skill uses to land the
committed review dataset. Both reject with the same converged
`{code, message, details}` error sub-object, but each verb fails on its own
first-found fault — never an accumulated bucket — and neither one emits a
`recovery` key. Both are commit-free preflights until a clean write; a reject
leaves no brief and no review file. `selection-audit-brief` never emits
`REVIEW_EXISTS`: on an existing brief its write-once guard instead returns a
success envelope with `skipped:true`, which `/plan:close` treats as the
re-close idempotence path.

| code              | emitted by                | meaning                                                                                                                                                                                         | recovery                                                                                                 |
| ----------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `REVIEW_EXISTS`   | `selection-review-submit` | A committed selection-review dataset already exists for the epic — the write-once guard refusing to race a second verdict set onto it.                                                          | Pass `--force` to re-submit despite the existing review, or leave the epic's dataset as-is.              |
| `VERDICT_INVALID` | `selection-review-submit` | The verdict payload is not valid JSON, is not a `{verdicts: [...]}` mapping, or fails shape/coverage validation (missing, extra, or duplicate task id; a non-enum `verdict`; empty `evidence`). | Fix every issue listed in `error.details.errors` and resubmit.                                           |
| `BRIEF_MISSING`   | `selection-review-submit` | No selection-audit brief exists yet for this epic.                                                                                                                                              | Run `keeper plan selection-audit-brief <epic_id>` first, then resubmit the verdict.                      |
| `BRIEF_CORRUPT`   | `selection-review-submit` | The audit brief is unreadable, or its `schema_version` is newer than this `keeper plan` build understands.                                                                                      | Re-run `selection-audit-brief` to regenerate it, or upgrade `keeper plan`.                               |
| `SIDECAR_MISSING` | `selection-audit-brief`   | The epic never ran through the post-scaffold cell selector (`assign-cells`), so there are no graded `{tier, model}` cells to audit.                                                             | Run cell selection for the epic before auditing; an epic with no selection sidecar has nothing to grade. |

### Per-task audit-gate verbs (`audit gate-check`, `audit submit-task`)

The content-blind seam `/plan:work`'s per-task audit gate polls between a flagged worker's
commit and its done-stamp. Both reject with the same converged `{code, message, details}`
error sub-object on first-found fault, and neither emits a `recovery` key — `gate-check` is
read-only (a git failure fails closed rather than fabricating a not-covering reading);
`submit-task` writes only the gitignored per-task finding artifact, never a `.keeper/`
commit.

| code              | emitted by                  | meaning                                                                                          | recovery                                                              |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `GIT_UNAVAILABLE` | `gate-check`, `submit-task` | Deriving the task's current commit set failed (the shared repo scan hit a git subprocess error). | Confirm the target/state repos are healthy git checkouts, then retry. |
| `BAD_STATUS`      | `submit-task`               | `--status` is missing or not one of `clean`, `mild`, `severe`.                                   | Pass a valid `--status` value and re-run.                             |
| `BAD_JSON`        | `submit-task`               | The `--file` payload is not valid JSON.                                                          | Fix the finding payload's JSON and re-run.                            |
| `BAD_PAYLOAD`     | `submit-task`               | The `--file` payload parsed but is not a JSON object.                                            | Pass a JSON object payload and re-run.                                |

Both verbs also share `BAD_TASK_ID | NOT_A_PROJECT | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID`
with the other task-scoped read verbs (`reconcile`, `resolve-task`, `find-task-commit`) —
see their `README.md` entries for that shared vocabulary's meaning and recovery.

## Operator paging

Operator pages use the configured absolute `agentbot` paging transport. A non-zero
transport exit is retried without creating a new alarm; an absent pager and a degraded
Agent Bus surface as producer-owned distress rows that clear only on positive recovery
evidence.

| code                  | meaning                                                                                                                                                      | recovery                                                                                                                                                     | retry-safe               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `paging-channel-down`         | Keeper could not spawn the configured local paging transport, so operator notifications cannot be delivered.                                                                        | Restore the configured absolute `agentbot` path and verify a subsequent page can be delivered; Keeper clears the row on that positive evidence.                                                    | automatic after repair                                   |
| `bus-degraded`                | The Agent Bus accept path stopped answering sustained probes while Keeper's critical READ server remained healthy, so the daemon stayed up in degraded mode.                         | Inspect bus clients and subscriber pressure; bounce keeperd only for a persistent internal bus wedge. The row clears when the armed bus probe answers again.                                                    | automatic after recovery                                 |
| `worktree-lane-backup-failed` | The autopilot recover producer could not snapshot a lane's dirt throughout the teardown grace, so it preserved the lane and raised a page-once distress row.                         | Restore the dirt-spool write path and leave the lane intact for a later recovery attempt. The producer clears the row only after complete enumeration or a path probe positively confirms that the lane is absent. | automatic after recovery; `retry_dispatch` does not apply |

## keeper commit-work

Every invocation emits exactly one line with
`{schema_version:1, kind:"commit-work-result", outcome, success, …}`. Preview is
`outcome:"preview"`; a local commit and its push state share the same envelope.
Usage and invocation-file faults exit 2 with `argument_error`; policy, ownership,
publication, and push failures exit 1. A failure also repeats `outcome` in the
flat `error` alias, but consumers should branch on `outcome`.

Automatic selection trusts only live exclusive tool/plan/direct claims owned by
an active Claude invocation. Bash, inferred, package-manager, and codegen evidence is reported as
`surface.observed_adoptable` and never auto-selected. A coverage gap is resolved
only by invocation-local `--adopt <path>` or a versioned `--adopt-from` manifest.
There is no raw-Git recovery: the private index freezes exact blob OIDs and modes,
then hooks, configured signing, commit-object verification, compare-and-swap ref
publication, and exact-SHA push remain mandatory.

| outcome                                                                                                                                 | meaning                                                                                                                                                                                                                                                         | recovery                                                                                                                                                                                             | retry-safe                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `argument_error`                                                                                                                        | CLI syntax, a malformed/oversized adoption manifest, an unreadable bounded input file, or both positional MSG and `--message-file`.                                                                                                                             | Correct the invocation or versioned input file, then retry.                                                                                                                                          | yes (nothing ran)           |
| `identity_conflict`, `invalid_identity`, `no_session_id`                                                                                | Invocation identity is conflicting, malformed, or absent. Adoption never bypasses identity.                                                                                                                                                                     | Supply one valid UUID identity and remove conflicting environment carriers.                                                                                                                          | yes (nothing committed)     |
| `identity_untrusted`, `task_unbound`                                                                                                    | The UUID is not a working tracked Claude/Pi job on this invocation's exact `(pid, start_time)` ancestor chain, or `--task-id` is not that work job's bound task.                                                                                                | Invoke from the owning active tracked session; a copied UUID/environment carrier from a sibling is not authority.                                                                                    | yes (nothing committed)     |
| `surface_unavailable`                                                                                                                   | Git could not provide the complete dirty surface.                                                                                                                                                                                                               | Restore the checkout/Git read path, preview again, then retry.                                                                                                                                       | yes                         |
| `receipts_pending`                                                                                                                      | Un-ingested receipts are the only blocker for an otherwise-terminal foreign claimant. `ingest_lag_events`, `ingest_lag_seconds`, and `stalled_ingester` report the bounded lag and whether the daemon ingester is down.                                         | Retry with bounded jitter; if `stalled_ingester` is true, restore the daemon ingester first. Do not broaden the adopted path set.                                                                    | yes                         |
| `ownership_conflict`                                                                                                                    | A selected/adopted path has a genuinely live or otherwise unknown foreign exclusive claimant.                                                                                                                                                                   | Let that claimant land or become positively terminal, or read the envelope's `request_release` pointer — it names the claimant and contested paths and carries a `keeper session release` invocation. Advise it as one bounded, best-effort bus notice; never signal or terminate a live claimant. Wait the grace window, then retry; a still-live conflict on retry escalates through the existing block ladder. Decline recording is deferred, so do not expect a decline annotation.                                                                                          | yes after ownership settles or release |
| `ownership_ambiguous`                                                                                                                   | Ownership evidence is unavailable/incomplete, multi-claim, or changed during lint/publication. Adoption requires durable evidence or a complete synchronous overlap observation.                                                                                | Restore the ownership reader or obtain complete direct evidence, then preview again; adopt only exact paths whose ownership is inspectable.                                                          | yes with fresh evidence     |
| `adoption_rejected`                                                                                                                     | An adopted path is outside the worktree, invalid, ignored, excluded, clean, or unknown. `selection.rejections` carries per-path codes.                                                                                                                          | Correct the exact manifest/path set; never replace it with a broad pathspec.                                                                                                                         | yes                         |
| `message_required`, `forbidden_trailer`                                                                                                 | A commit message is absent or contains any caller-supplied authority trailer, including `Task:`.                                                                                                                                                                | Supply plain prose and use the bound `--task-id`; Keeper appends identity/task authority mechanically.                                                                                               | yes                         |
| `operation_in_progress`                                                                                                                 | Merge, cherry-pick, revert, rebase, or bisect state appeared before publication. No override exists.                                                                                                                                                            | Finish/abort the operation (or reset bisect), preview, and retry.                                                                                                                                    | yes after settlement        |
| `shared_checkout_jam`                                                                                                                   | A live repo-scoped shared-checkout dirty/desync distress row blocks publication; `distress_row_id` names it and `clear_condition` states the producer evidence that removes it.                                                                                 | Wait for the named Distress row's producer clear condition, or use `--override-jam` only after inspecting the checkout.                                                                              | conditional                 |
| `lock_timeout`                                                                                                                          | Another commit/base-merge retained the per-worktree flock past the deadline.                                                                                                                                                                                    | Wait for that operation to finish, then retry unchanged.                                                                                                                                             | yes                         |
| `file_list_too_large`                                                                                                                   | The selected set exceeds `--max-files`.                                                                                                                                                                                                                         | Inspect the preview; narrow it or deliberately raise/disable the cap.                                                                                                                                | yes                         |
| `stale_index_carryover`                                                                                                                 | Ambient staged paths exist outside the selected set.                                                                                                                                                                                                            | Preserve the other work, or use `--allow-stale-unstage` to restore only those ambient entries before the private commit. Do not raw-commit a mixed set.                                              | conditional                 |
| `unmerged_paths`, `directory_file_conflict`                                                                                             | The selected/index surface is conflicted or cannot represent the exact path set safely.                                                                                                                                                                         | Resolve the conflict without broad staging, then preview and retry.                                                                                                                                  | yes after repair            |
| `mass_reversion`                                                                                                                        | The frozen set matches the bulk ancestor-reversion signature.                                                                                                                                                                                                   | Inspect history; use `--allow-mass-reversion` only for an intentional revert.                                                                                                                        | conditional                 |
| `lint_failed`                                                                                                                           | The scoped lint matrix rejected the frozen non-deleted paths.                                                                                                                                                                                                   | Fix the reported files and re-run the same message/adoption decision. Adoption is not a lint bypass.                                                                                                 | yes after fixing            |
| `surface_changed`                                                                                                                       | A selected OID/mode/tree or automatic claim identity changed after freeze, or a non-excluded caller-owned surface changed before publication. Untracked Excluded-prefix runtime churn is outside this compare; hook/config mutation defense remains whole-tree. | Re-preview and make a fresh adoption decision against current selected bytes and non-excluded surfaces.                                                                                              | yes with fresh evidence     |
| `commit_hook_mutated`                                                                                                                   | A hook, signer, or linter changed the complete worktree, branch, either index, Git config/signing policy, or the captured hook set. Nothing was published unless `commit.sha` says otherwise.                                                                   | Inspect the named executable side effect; make it validation-only or commit generated output in a separate fresh invocation.                                                                         | conditional                 |
| `commit_failed`, `commit_signing_failed`, `head_read_failed`, `index_seed_failed`, `stage_failed`, `tree_write_failed`, `detached_head` | Exact private-index construction or commit-object creation could not complete.                                                                                                                                                                                  | Fix the typed Git/signing/repository condition (including removing or integrating an executable `reference-transaction` hook), preview, and retry; never disable verification/signing as a shortcut. | conditional                 |
| `commit_state_indeterminate`                                                                                                            | A bounded Publication CAS attempt timed out, was signaled, or lost complete output, so Keeper cannot prove whether the exact commit became visible. Internal HEAD-advance retry never treats this unknown state as a definite conflict.                         | Inspect the named commit SHA and captured branch before any retry; never recreate or roll back the commit blindly.                                                                                   | conditional                 |
| `ref_conflict`                                                                                                                          | Publication CAS observed a non-advance, a HEAD advance overlapping the Frozen selection, or exhausted bounded non-overlapping re-freeze attempts. `attempts` reports the publication attempts; no moved ref is rolled back or overwritten.                      | Reconcile the current tip and selected paths, preview again, then retry.                                                                                                                             | yes with fresh base         |
| `post_commit_hook_failed`                                                                                                               | CAS publication succeeded, then `post-commit` failed. The envelope carries `committed:true`, the exact SHA, and `pushed:false`.                                                                                                                                 | Treat the local commit as real; fix/run the post-commit side effect, then push that exact SHA deliberately. Do not retry the commit.                                                                 | no (already committed)      |
| `push_state_indeterminate`                                                                                                              | Local publication succeeded, but the bounded exact-SHA push timed out, lost complete output, or was signaled after the remote write may have occurred; `pushed` is `null`.                                                                                      | Probe the exact remote ref before any retry or tracking change. Never infer failure from missing client output.                                                                                      | no commit retry             |
| `push_failed`                                                                                                                           | Local publication succeeded and the exact-SHA remote update returned a definite refusal.                                                                                                                                                                        | Use `push.push_error_class` to fix auth/non-fast-forward/hook state, then push or reconcile the reported exact SHA.                                                                                  | no commit retry             |
| `nothing_to_commit`                                                                                                                     | The selected paths produce the parent tree exactly.                                                                                                                                                                                                             | Nothing to do; inspect current dirt if a change was expected.                                                                                                                                        | yes (successful no-op)      |
| `internal_error`                                                                                                                        | An unexpected implementation fault escaped typed handling.                                                                                                                                                                                                      | Preserve the envelope and diagnose Keeper; do not loop blindly.                                                                                                                                      | no automatic retry          |

`ambient_reconciliation_warning` is not an outcome: the exact commit is already
published, but Keeper could not reconcile selected entries back into the ambient
index without risking concurrent staged work. Preserve the warning and repair the
ambient index separately; never recreate the commit.
