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

The restart verb asks launchd to restart the already bootstrapped keeperd job, then
waits for a socket reply whose boot status is caught up. It never opens keeper.db
or invokes a daemon RPC. A refused socket while the old process releases its flock
is transient. Plist edits are a different operation: use `launchctl bootout` plus
`launchctl bootstrap`, not `kickstart`.

| code | meaning | recovery | retry-safe |
| ---- | ------- | -------- | ---------- |
| `kickstart-failed` | `launchctl kickstart -k` could not ask launchd to restart the job. | Confirm the LaunchAgent is bootstrapped. For plist edits, bootout then bootstrap it before retrying. | yes (restart request) |
| `health-timeout` | The bounded wait ended before the daemon answered healthy and caught up. | Inspect launchd status and daemon stderr, fix the boot fault, then retry. | yes (restart request) |
| `throttled-respawn` | launchd is delaying keeperd after repeated respawns. | Inspect daemon stderr for the crash loop, fix it, then retry. | yes (after fixing the boot fault) |


## Shared-helper family (`keeper status`, `keeper query`)

These ride the `{schema_version, ok, error, data}` envelope on stdout. A bad
board / bad domain state is `data` at exit 0; only a transport or usage failure
is `ok:false` at exit 1, and the envelope still lands on stdout.

| code           | emitted by     | meaning                                                                                   | recovery                                                                 | retry-safe |
| -------------- | -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| `unreachable`  | `keeper status`| The daemon did not answer within the bounded connect deadline (it is down or starting).   | Confirm the daemon is running (its LaunchAgent restarts it), then retry.  | yes (read-only) |
| `connect`      | `keeper status`| A connect / transport fault reaching the daemon socket, short of the deadline.            | Confirm the daemon and socket path, then retry.                          | yes (read-only) |
| `query_failed` | `keeper query` | Any transport failure during a query round-trip: connect fail, response timeout, a daemon `error` frame, or a malformed / unexpected frame. `message` carries the specific cause. | Retry the read; a query is read-only and retry-safe. If it persists, confirm the daemon is running. | yes (read-only) |

Every code above is a read-path failure, so a retry never risks a double-mutate.

## Unified history, job reads, and foreground resume

`history list/show` read native Claude/Pi artifacts plus optional Keeper aliases.
`history search/files` also refresh the disposable private History index; index
maintenance mutates only that index. Native-only Sessions carry no Keeper
job/event/attribution rows. A shared Session reference never newest-collapses an
ambiguity.

| code | emitted by | meaning / recovery | retry-safe |
| ---- | ---------- | ------------------ | ---------- |
| `keeper_jobs_read_failed` | `history list|show|search|files`, `history index refresh|rebuild` | Keeper aliases could not be read safely. Confirm keeper.db health; use the specialist native `keeper transcript` reader when aliases are unavailable. | yes; no source mutation |
| `session_not_found`, `session_ambiguous` | `history show`, scoped `search/files` | The shared reference missed or stayed ambiguous. Run `keeper history list --format json`; retry with a qualified id, `--project`, and for `show` an exact `--artifact` when needed. | yes; no source mutation |
| `artifact_unavailable`, `unsupported_harness`, `read_failed`, `subagent_not_found` | `history show` | The selected native artifact cannot be rendered or the specialist subagent selector missed. Choose a readable Claude/Pi artifact or a listed subagent. | yes; no source mutation |
| `index_refresh_failed`, `index_read_failed` | `history search|files` | The private History index could not refresh or read. Retry or run `keeper history index rebuild`. | yes; refresh is idempotent and index-only |
| `invalid_fts_query` | `history search --syntax fts` | Raw FTS5 syntax is malformed. Revise it or use the default literal syntax. Empty and oversized queries are usage errors on stderr, not problem envelopes. | yes |
| `index_operation_failed` | `history index` | Status/refresh/rebuild/purge failed. Confirm owner permissions and History-index path availability, then retry; purge/rebuild remain safe because the index is disposable. | yes; index-only mutation |
| `catalog_read_failed`, `keeper_jobs_unavailable`, `session_not_found`, `session_ambiguous`, `not_tracked`, `job_ambiguous` | `show-job <session-reference>` | Catalog or job resolution failed honestly. Follow `error.recovery`; choose a qualified Session reference or exact job id, and use `keeper history show` for native-only history. | yes; read-only |
| `read_failed`, `not_found`, `ambiguous` | `show-job` | keeper.db could not be read, no job matched, or several job-only candidates remain. Narrow with exact `--job-id`, `--cwd`, or `--pane`; `--latest` applies only to an explicitly job-only query. | yes; read-only |

`keeper resume` returns before launch for `catalog_read_failed`,
`session_not_found`, `session_ambiguous`, `picker_cancelled`, `picker_invalid`,
`artifact_ambiguous`, `artifact_missing`, `artifact_unreadable`,
`artifact_identity_conflict`, `artifact_cwd_unresolved`, `cwd_vanished`,
`current_cwd_vanished`, `alias_conflict`, `unsupported_harness`, `session_live`,
and `wrong_cwd`. Follow `error.recovery`; `wrong_cwd` carries the shell-safe
re-entry command. `binary_not_found` and `launch_failed` identify native harness
startup failures—confirm no process started before retrying.

## Autopilot control ops (`keeper autopilot pause|play|mode|arm|disarm|retry|config|worktree`)

Each control op round-trips one control RPC and rides the shared envelope. The
daemon's echoed result value is `data` (ok:true, exit 0); a server rejection,
transport fault, or unexpected frame is `ok:false` (exit 1) on stdout. A control
RPC MUTATES, so the transport-failure recovery is mutate-aware (a pre-send
connect failure is safe to retry; a mid-flight timeout may already have applied).
CLI-usage errors (bad args) stay on stderr at exit 1, off the envelope.

| code                   | meaning                                                                 | recovery                                                                                             | retry-safe |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| `rpc_unreachable`      | The daemon did not answer the control RPC over its socket.              | Confirm the daemon is running. A pre-send connect failure is safe to retry; a mid-flight timeout may have applied — re-read state (`keeper autopilot` / `keeper status`) before retrying. | conditional |
| `rpc_rejected`         | The daemon rejected the RPC (its `error` frame code passes through when present). | Correct the request per the code, then retry — a rejected RPC did not mutate state.                | yes (not applied) |
| `rpc_unexpected_frame` | The daemon returned a frame type the control path did not expect.       | Retry; if it persists, confirm the daemon and CLI are the same version.                             | conditional |

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

| code          | emitted by         | meaning                                                                                       | recovery                                                                                            | retry-safe |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| `read_failed` | `keeper tabs list` | keeper.db could not be opened / read for the generation-summary read.                         | Retry — the read opens keeper.db read-only and never mutates. If it persists, confirm the daemon is healthy. | yes (read-only) |

Exit codes (published in `keeper --help --json`, distinct from the usage code and
the await-owned range):

| exit | emitted by               | meaning                                                                                       |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------- |
| 6    | `keeper tabs restore`    | Refused a non-TTY AMBIGUOUS selection (the richest generation is not the freshest); the ranked table prints on stderr. Re-run with `--generation <id>` or on a TTY for the picker. |
| 7    | `keeper tabs restore --apply` | ZERO candidates without `--allow-empty`. Pass `--allow-empty` to proceed with an empty set, or drop `--apply` to inspect the plan. |
| 8    | `keeper tabs restore --apply` | PARTIAL launch failure — some candidates relaunched, some failed; the restored/failed summary prints on stdout. Re-run to retry the failures (already-live sessions are deduped). |

## Agent provider matrix (`keeper agent providers resolve|check`)

The host-matrix doctor verbs read the REQUIRED `~/.config/keeper/matrix.yaml` v2
(ADR 0036) — the ordered provider roster that grows the worker model axis beyond
claude. They emit a structured JSON line on stdout (`resolve`'s candidate
envelope, `check`'s findings) and human diagnostics on stderr; neither rides the
shared `cli/envelope.ts` shape. Reads only; nothing is mutated.

`resolve <model> <effort>` emits `{schema_version, model, effort, driver,
candidates:[{harness, model_id, preset_name}], defaults}` at exit 0. On the
unroutable path it emits `{schema_version, error:"no_route", model, effort,
driver, candidates:[]}`. An ABSENT matrix is a typed loud failure (exit 2, ADR
0036) naming the state and the copy-the-example fix — there is no claude-native
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

| code       | verb                        | meaning                                                                                          | recovery                                                                                 | retry-safe |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------- |
| `no_route` | `agent providers resolve`   | A wrapped (non-claude) model has no configured provider in the roster (empty candidate list).     | Add a provider serving the model to `~/.config/keeper/matrix.yaml`, or correct the token. | yes (read-only) |

`check`'s host-triple findings are lints over `presets.yaml`'s `dispatch:` per-verb
table (ADR 0040) and `panel.yaml`'s members. Every `dispatch:` row that resolves a
non-null triple is checked; an unset row simply contributes no finding (it floors to
the compiled-in default at dispatch time, never a drift target here).

| kind               | `source` examples                                                    | meaning                                                                          | recovery                                                                                                 | retry-safe       |
| ------------------ | ---------------------------------------------------------------------| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `binary-unreachable` | (none — carries `provider`/`binary`)                                | A roster provider's harness binary is off PATH.                                   | Install the missing binary, or drop the provider from `matrix.yaml`.                                       | yes (read-only)  |
| `off-cube-triple`  | `claude_default`, `dispatch.work`, `dispatch.unblock`, `panel 'x' member 1` | A well-formed `<harness>::<model>::<effort>` triple names a combination the roster does not enumerate. | Correct the triple in `presets.yaml`/`panel.yaml`, or add the model/effort to `matrix.yaml`.                | yes (read-only)  |
| `malformed-triple` | `dispatch.close`, `codex_default`, `panel 'x' member 2`               | A host triple fails the `<harness>::<model>::<effort>` grammar (tool fault, not drift). | Fix the triple's syntax in `presets.yaml`/`panel.yaml`.                                                     | yes (read-only)  |

Exit codes (distinct from the shared 0/1/2 core, published in `keeper --help --json`):

| exit | verb                      | meaning                                                                                              |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2    | `agent providers resolve` | A model/effort token violates the name charset (lowercase alnum, hyphen, underscore, dot; no leading dot), or the matrix is malformed. |
| 3    | `agent providers resolve` | `no_route` — a wrapped model has no configured provider in the roster. Add a serving provider or correct the model token. |
| 1    | `agent providers check`   | Tool fault — the matrix is malformed (ConfigError naming the offense on stderr), OR a host launch triple is malformed (the grammar rejects a `<harness>_default` / `dispatch:` verb row / panel member); each malformed triple prints one line. |
| 9    | `agent providers check`   | One or more roster/host-triple/reachability drift findings (an unreachable provider binary, or a well-formed host launch triple outside the enumerable cube); each finding prints one line. |

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

| state / token | meaning | recovery | retry-safe |
| ------------- | ------- | -------- | ---------- |
| `cancelled` | The cancellation tombstone was persisted and every registered member identity settled. | Inspect retained outputs if needed; start a deliberately new request only for a new invocation. | no (the request is terminal) |
| `cleanup_failed` | Bounded cancellation could not prove one or more exact `member#attempt` identities dead; `unresolved_cleanup` lists them. Success is withheld. | Inspect the listed run-directory identities and their per-run control artifacts; reap only their recorded PID/start-time and socket-qualified tmux target, then retain the run for forensics. Never use broad process matching. | no automatic retry |
| `no_message` | A member terminated without a usable answer. It counts as a failed leg for quorum. | Let the content-blind quorum decide the request; do not relaunch the leg implicitly. | no automatic retry |
| `PANEL_RUN_FAILED` | The owned runner reached a terminal failure and produced no panel answer. | Use its one-line reason and run directory to inspect the reservation. A later intentional inquiry needs a new request identity. | no automatic retry |

## Worker-cell launch rejects (`keeper dispatch`, autopilot)

The launcher-owned worker-cell seam (`src/worker-cell.ts`) rejects a doomed
`work` launch BEFORE spawning: the autopilot producer mints a sticky
`DispatchFailed` (cleared by `retry_dispatch`), and manual `keeper dispatch` dies
non-zero (exit 1) with the same reason. These are launch-time reason tokens
(carried in the sticky reason / stderr message), NOT shared-envelope codes. The
shared precedence is bad matrix → provider reject → invalid cell → missing
manifest → stale cohort → shadowed plugin → launch.

| code                     | emitted by                     | meaning                                                                                                                | recovery                                                                                                              | retry-safe |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------- |
| `worker-cell-bad-matrix` | autopilot producer, `dispatch` | The host worker matrix (`~/.config/keeper/matrix.yaml`) failed to load — one of four states the reason NAMES: `absent` (no file), `unparseable` (bad YAML / unreadable), `schema-invalid` (a shape violation — e.g. a retired `route:`/`native:`/`name:`/`subagents:` key), or `valid-but-empty` (an empty file). No cell can compose, so the daemon parks every cell-bearing `work` dispatch behind this sticky and never exits. | Copy `docs/examples/matrix.example.yaml` to `~/.config/keeper/matrix.yaml` and edit it (the message names the exact path + fix), then `keeper retry-dispatch` (autopilot) / re-run (manual). | yes (fix config first) |
| `worker-cell-invalid` | autopilot producer, `dispatch` | The task's effective `{model, tier}` pair is outside the live matrix's ragged worker-cell axes, so no cell path can be selected. | Correct the task assignment or matrix, compile the cohort, then `keeper retry-dispatch` / re-run. | yes (fix assignment or matrix first) |
| `worker-cell-missing` | autopilot producer, `dispatch` | The selected cell's `.claude-plugin/plugin.json` is absent. Claude would infer the directory basename instead of loading the constant `work:worker`, so launch is refused before any session starts. | Run `keeper prompt compile --role work:worker --target claude`, then `keeper retry-dispatch` / re-run. | yes |
| `worker-cell-stale` | autopilot producer, `dispatch` | A selected manifest exists, but the compiler-owned cohort fails its current source fingerprint, canonical inventory, hash/sidecar verification, or exact selected-cell membership check. Runtime verification is read-only and never repairs silently. | Run `keeper prompt compile --role work:worker --target claude`; use the same command with `--check` to verify, then `keeper retry-dispatch` / re-run. | yes |
| `work-plugin-shadowed` | autopilot producer, `dispatch` | Another preloaded plugin claims the `work` name. Only the selected cell's exact physical directory is legitimate; configured hard plugins, active scan results, cwd plugins, and sibling worker cells are all rejected when they would steal `work:worker`. | Remove or rename the named plugin, or enable `worker_plugin_isolation: strip-scan-dirs` when the collision comes only from `plugin_scan_dirs`; then `keeper retry-dispatch` / re-run. | yes (fix plugin composition first) |
| `worker-provider-no-map-entry` | autopilot producer, `dispatch` | The `worker_provider` pin (ADR 0047) must translate this cell's assigned cell into the pinned family, but the cross-provider equivalence map has NO entry for it in the required direction. The reason NAMES the assigned cell + direction. Fail-closed — the pin NEVER falls back to the assigned provider. | Add the mapping to `plugins/plan/provider-equivalence.yaml` (re-run `bun plugins/plan/scripts/model-guidance-check.ts --check`), then `keeper retry-dispatch` (autopilot) / re-run (manual) — OR clear the pin (`keeper autopilot config worker_provider none`). | yes (fix map or clear pin) |
| `worker-provider-target-not-on-host` | autopilot producer, `dispatch` | The map's entry translated the assigned cell to a target cell that is NOT a dispatchable cell on the live host matrix (target model or its effort absent). The reason NAMES the assigned + mapped cell + direction. Fail-closed — no fallback. | Fix the map target (or add the target cell to `matrix.yaml`'s `subagent_models`/efforts), then `keeper retry-dispatch` / re-run — OR clear the pin. | yes (fix map/matrix or clear pin) |
| `worker-provider-map-malformed` | autopilot producer, `dispatch` | The `worker_provider` pin is set but `provider-equivalence.yaml` failed to load/parse at dispatch (the drift gate is offline). The reason NAMES the assigned cell + direction + the parse detail. Fail-closed PER CELL — a stale map parks dispatch, never crashes the cycle. | Fix `plugins/plan/provider-equivalence.yaml` (re-run the `--check` drift gate), then `keeper retry-dispatch` / re-run — OR clear the pin. | yes (fix map or clear pin) |

Distinct from the run-time `no_route` the `agent providers resolve` verb emits
(above): that is a read-time doctor verdict, this is a launch-time dispatch
reject that parks the task.

The three `worker-provider-*` rejects surface ONLY while `autopilot_state.worker_provider`
is pinned (`claude`/`codex`), the durable work-dispatch provider pin that translates each
task's assigned worker cell through the committed equivalence map at launch. They are the
override's observability contract: an untranslatable cell spikes a visible sticky rather
than silently starving the board or falling back to the wrong provider family.

## Lifecycle evidence diagnostics

`bun scripts/audit-session-activity.ts --db <snapshot> --limit <n>` is the offline, read-only view of
Harness activity, Dispatch attempts, Dispatch claims, and their classification deltas. Its reasons are diagnostic
values, not shared-envelope codes. Follow up by identifier; never infer activity from a pane, pid, path,
or title alone.

| output / reason | meaning | recovery |
| --------------- | ------- | -------- |
| `child-evidence-incomplete`, `resource-evidence-incomplete`, `parent-state-incomplete` | Harness activity is `unknown` because required projected evidence is absent, malformed, or contradictory. Capacity, conflicting dispatch, autoclose, finalize, and destructive cleanup fail closed. | Check projection health and the named session's recent lifecycle events. Repair the producer or replay a dead letter when one is present, then take a fresh snapshot; do not force the session quiescent. |
| `child-evidence-stale`, `resource-evidence-stale` | An open child or work-bearing resource has not supplied freshness evidence, so elapsed time cannot prove idle. | Confirm the exact child/resource identity. If it is live, restore its event producer; if positively dead, let the normal exit/reconcile path record terminal evidence. Re-run the audit on a fresh snapshot. |
| `stale_attempts` / `stale-pending` | A Dispatch attempt remains pending beyond the launch-window ceiling. A delayed start does not gain authority unless its attempt identity still matches the current Dispatch claim. | Inspect the target's `pending_dispatches`, `dispatch_claims`, and dispatch-failure row. Let the expiry/reconciler path fence it; retry a sticky failure only after confirming no current exact Dispatch claim or live activity owns the target. |
| provisional or absent cut/clean settlement | Provider transcript evidence has not crossed its terminal settlement boundary. An intermediate cut cannot stop the parent or unlock lifecycle consumers. | Preserve the complete transcript tail and restore the transcript worker/read path. A later clean terminal record settles the same invocation; a torn partial line is ignored rather than repaired by hand. |
| `legacy-unfenced` | The session has no exact Dispatch attempt identity. It may still carry Harness activity and a Resource hold, but cannot acquire or consume a newer exact Dispatch claim. | Let the session reach a positive terminal boundary. Use a fresh exact attempt for later dispatch; do not assign a guessed attempt id to the legacy row. |

## Resource cleanup diagnostics

Autoclose and worktree teardown fail closed when exact Resource hold identity cannot be re-proved. These
reason prefixes are operator-visible diagnostics, not shared-envelope codes.

| reason prefix | meaning | recovery | retry-safe |
| ------------- | ------- | -------- | ---------- |
| `worktree-finalize-cleanup-conflict` | The recorded lane path is registered to a different branch or no longer proves keeper lane ownership. Keeper will not remove it. | Inspect the named worktree and owner; remove or relocate the replacement only if intentional. The next reconcile retries from fresh identity evidence. | yes (after identity is reconciled) |
| `resource-generation-unknown` / `resource-generation-unobserved` | The tmux probe did not provide a canonical generation matching the recorded Resource hold. Cleanup remains deferred. | Restore tmux probe health and let the next pulse re-observe it; do not delete by pane id or path manually. | yes (automatic read retry) |
| `resource-generation-mismatch` | The pane id now belongs to another tmux server generation. The old cleanup intent is fenced and cannot target it. | Leave the replacement pane alone. Keeper retries only after current projection evidence settles. | yes (automatic read retry) |

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

| code                          | emitted by          | meaning                                                                                                        | recovery                                                                                                   | retry-safe |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| `wrapped-delegation-skipped`  | autopilot producer  | A wrapped-cell task done-stamped with no provider-leg result envelope at its `KEEPER_WRAPPED_ENVELOPE` path — advisory evidence the wrapper skipped delegation and implemented with claude tokens directly. | Advisory only — inspect the task's commit; no dispatch to retry. Clears itself once a later task's envelope lands, or the line simply stops recurring once the coalesce window lapses. | n/a (advisory, no sticky) |

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

| code                 | meaning                                                        | recovery                                                                    |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bad_yaml`           | The scaffold / refine YAML is malformed.                      | Fix the reported parse or shape error in the input and re-run.              |
| `brief_missing`      | `apply-selection` found no selection brief on disk for the epic, or the brief's `from_followup` flag does not match the invocation. | Run `keeper plan selection-brief <epic_id>` (add `--from-followup` for a follow-up) before applying the verdict. |
| `cell_invalid`       | An `assign-cells` or `apply-selection` cell set is invalid: an out-of-axis tier/model, or an unknown, duplicate, missing, or non-todo task id (the full-set + todo-only contract), including a brief-vs-live axis divergence detected at `apply-selection` apply time. | Correct the cells so every todo task of the epic is covered exactly once with in-axis values, then re-run. |
| `dep_cycle`          | The task dependency graph has a cycle.                        | Break the cycle among the listed tasks, then re-run.                        |
| `dep_invalid`        | A declared task dependency does not resolve.                  | Correct the referenced task id (or remove the edge) and re-run.            |
| `epic_dep_invalid`   | A declared epic dependency does not resolve.                  | Correct the referenced epic id (or remove the edge) and re-run.           |
| `duplicate_epic`     | An epic with this slug already exists.                        | Choose a distinct slug, or pass `--allow-duplicate` to create a sibling.    |
| `id_collision`       | A generated id collides with an existing artifact.           | Re-run with a distinct slug or id.                                          |
| `integrity_failed`   | The post-write integrity check failed; nothing was committed.| Re-run the verb; if it persists, inspect the reported artifacts.           |
| `merge_in_progress`  | Commit-time RETRYABLE: the state repo is mid-operation — a merge / cherry-pick / revert / rebase / sequencer (the one keeper's own machinery creates is a merge), OR the shared commit-work lock is held by a concurrent commit / base-merge past the deadline. `details` names the operation. The verb wrote nothing. | Wait for the operation to finish, then re-run the verb unchanged — no input fix needed. |
| `target_invalid`     | The target id is not well-formed or does not exist.          | Correct the target and re-run.                                             |
| `spec_invalid`       | A task or epic spec field is missing or malformed.          | Fix the reported spec field and re-run.                                    |
| `model_invalid`      | The declared model is not recognized.                        | Set a supported model value and re-run.                                    |
| `tier_invalid`       | The declared tier is out of range.                           | Set a supported tier value and re-run.                                     |
| `repo_invalid`       | The repo path is not a valid git repo root.                 | Correct the repo path and re-run.                                         |
| `missing_session_id` | No session id is available for a mutating verb.             | Ensure the invocation carries a session id and re-run.                    |
| `verdict_invalid`    | An `apply-selection` selector verdict is malformed: unparseable JSON, an error-shaped `{"error": ...}` return, an unknown top-level key, or a cell out of the brief's candidate axes or coverage (also the `--degraded` + `--from-followup` combination). | Fix every issue listed in `error.details` and re-pipe the verdict on stdin. |
| *(unlisted)*         | Any other accumulate-all failure code.                       | Fix the reported problems in the input and re-run; `details` lists them.   |

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

| code              | emitted by                                     | meaning                                                                                                                                                    | recovery                                                                                       |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `REVIEW_EXISTS`   | `selection-review-submit`                       | A committed selection-review dataset already exists for the epic — the write-once guard refusing to race a second verdict set onto it.                        | Pass `--force` to re-submit despite the existing review, or leave the epic's dataset as-is. |
| `VERDICT_INVALID` | `selection-review-submit`                       | The verdict payload is not valid JSON, is not a `{verdicts: [...]}` mapping, or fails shape/coverage validation (missing, extra, or duplicate task id; a non-enum `verdict`; empty `evidence`). | Fix every issue listed in `error.details.errors` and resubmit.                                   |
| `BRIEF_MISSING`   | `selection-review-submit`                       | No selection-audit brief exists yet for this epic.                                                                                                            | Run `keeper plan selection-audit-brief <epic_id>` first, then resubmit the verdict.               |
| `BRIEF_CORRUPT`   | `selection-review-submit`                       | The audit brief is unreadable, or its `schema_version` is newer than this `keeper plan` build understands.                                                    | Re-run `selection-audit-brief` to regenerate it, or upgrade `keeper plan`.                        |
| `SIDECAR_MISSING` | `selection-audit-brief`                         | The epic never ran through the post-scaffold cell selector (`assign-cells`), so there are no graded `{tier, model}` cells to audit.                            | Run cell selection for the epic before auditing; an epic with no selection sidecar has nothing to grade. |

### Per-task audit-gate verbs (`audit gate-check`, `audit submit-task`)

The content-blind seam `/plan:work`'s per-task audit gate polls between a flagged worker's
commit and its done-stamp. Both reject with the same converged `{code, message, details}`
error sub-object on first-found fault, and neither emits a `recovery` key — `gate-check` is
read-only (a git failure fails closed rather than fabricating a not-covering reading);
`submit-task` writes only the gitignored per-task finding artifact, never a `.keeper/`
commit.

| code             | emitted by                    | meaning                                                                                          | recovery                                                                 |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GIT_UNAVAILABLE`| `gate-check`, `submit-task`    | Deriving the task's current commit set failed (the shared repo scan hit a git subprocess error).   | Confirm the target/state repos are healthy git checkouts, then retry.      |
| `BAD_STATUS`     | `submit-task`                  | `--status` is missing or not one of `clean`, `mild`, `severe`.                                     | Pass a valid `--status` value and re-run.                                  |
| `BAD_JSON`       | `submit-task`                  | The `--file` payload is not valid JSON.                                                            | Fix the finding payload's JSON and re-run.                                 |
| `BAD_PAYLOAD`    | `submit-task`                  | The `--file` payload parsed but is not a JSON object.                                              | Pass a JSON object payload and re-run.                                     |

Both verbs also share `BAD_TASK_ID | NOT_A_PROJECT | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID`
with the other task-scoped read verbs (`reconcile`, `resolve-task`, `find-task-commit`) —
see their `README.md` entries for that shared vocabulary's meaning and recovery.

## keeper commit-work

`cli/commit-work.ts` stages the session-attributed dirty set, runs the lint matrix,
commits pathspec-limited, and pushes. Every failure is a compact single-line
`{"success": false, "error": "<code>", …}` envelope at exit 1 (an arg fault is exit 2).
Three repo-state gates plus the index-purity gate guard the commit; each names the ONE
sanctioned exception — plain-git-with-explicit-paths — as the deliberate mixed-commit path
it exists to make visible (`git add <explicit paths>` — never `-A` / `.` — then `git commit`
/ `git push`). That escape hatch, the `--allow-stale-unstage` / `--override-jam` /
`--allow-mass-reversion` overrides, and this table tell ONE recovery story; the commit stays
pathspec-limited even when a gate is overridden, so a poisoned index never enters the tree.

| code                     | meaning                                                                                                                                                                                                 | recovery                                                                                                                                                                            | retry-safe |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `operation_in_progress`  | Gate 1 (pre-lock, NO override). The repo is mid-merge / -cherry-pick / -revert / -rebase / -bisect (probed worktree-portably via `rev-parse`); `operation` names it. A full commit here silently makes a two-parent merge commit — the shape that spread the incident's stale blobs through an auto-merge. Nothing was staged or committed. | Conclude the operation (finish it, or `git bisect reset`) or abort it (`git <op> --abort`), then re-run unchanged. No override — a mid-operation partial commit is never correct. | yes (after the op concludes / aborts) |
| `shared_checkout_jam`    | Gate 2 (pre-lock, `--override-jam`). A live `dispatch_failures` shared-checkout **dirty** / **desync** distress row (`shared-checkout-{dirty,desync}:<hash>`) matches this repo under a normalized dir compare — the working tree may trail landed history, so a commit risks sweeping stale content. FAIL-OPEN: a repo with no keeper.db (or an unreadable one) commits normally. | Let the daemon recover the checkout: dirt is backed up to the lane dirt spool and cleaned only when every cwd-matched writer is grace-stale and provably dead, with no merge in progress; ambiguous ownership pages once and remains untouched. Desync recovery and the observed-clean tracker clear the row. Inspect with `keeper query dispatch_failures`; if the staged set is certainly correct and current, `--override-jam` remains available. | yes (once the jam clears, or with `--override-jam`) |
| `mass_reversion`         | Gate 3 (in-lock, `--allow-mass-reversion`). The staged set mass-matches ANCESTOR blobs while differing from HEAD (≥ 5 paths AND ≥ 30% of the staged set, excluding gitlinks + regenerated surfaces) — the desynced-checkout bulk-revert signature green suites cannot catch (the tests revert in the same sweep). `count` / `staged` / `sample` name the flagged paths. Nothing was committed. | Inspect the flagged paths against landed history (`git log -p -- <path>`). For a genuine intended bulk revert, re-run with `--allow-mass-reversion`; otherwise the checkout is stale — reconcile it with landed history first. | yes (with `--allow-mass-reversion`, or after reconciling the checkout) |
| `unmerged_paths`         | Gate 3. The index carries unmerged (stage 1/2/3) paths — committing now would record a half-resolved conflict. `sample` names them. Nothing was committed. | Resolve the conflicted paths (`git add` each once fixed) or abort the in-progress operation, then re-run. | yes (once the conflict is resolved) |
| `stale_index_carryover`  | Index-purity gate (in-lock, `--allow-stale-unstage`). Staged content sits OUTSIDE the session-attributed set — a dead worker's residue, a shared checkout trailing landed history, or a git-apply / codegen / script write the attribution hooks never saw. `sample` lists the offending paths. The default refuses (never a silent unstage); the commit is always pathspec-limited so the extras cannot leak. | If the extra paths are genuinely yours, commit the mixed set with plain git + explicit paths; otherwise re-run with `--allow-stale-unstage` to unstage the extras and commit only the attributed set. | yes (with either recovery path) |
| `nothing_to_commit`      | The session-attributed files were discovered + staged but carry no actual index change (already committed, or their edits were reverted) — an empty-tree commit was skipped. | Nothing to do; if you expected a change, confirm the files still differ from HEAD. | yes (read-only outcome) |

The lint (`lint_failed`), coverage (`file_list_too_large`), session (`no_session_id`), and
message (`forbidden trailer pattern`) envelopes are documented inline in the verb's `--help`
/ `--agent-help`; `lint_failed`'s only recovery loops back through `commit-work` (fix →
`git add` → re-invoke the SAME message), never a bare-git bypass.
