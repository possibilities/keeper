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

## In-binary bare readers (`show-job`, `search-history`, `find-file-history`, `show-session-events`)

These open keeper.db read-only and ride the `{schema_version, ok, error, data}`
envelope. A hit is `data` at exit 0; a keeper.db read failure or a resolver miss
is `ok:false` at exit 1, still on stdout. Messages are corrective — never a raw
`String(e)`, a stack trace, or a filesystem path.

| code          | emitted by        | meaning                                                            | recovery                                                                          | retry-safe |
| ------------- | ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| `read_failed` | the bare readers  | keeper.db could not be opened / read for this one-shot read.       | Retry — the read opens keeper.db read-only and never mutates. If it persists, confirm the daemon is healthy. | yes (read-only) |
| `not_found`   | `keeper show-job` | No job matched the given selectors.                               | Widen or correct the selector (--job-id / --session-title / --cwd / --pane), or run with no selector to auto-detect. | yes (read-only) |
| `ambiguous`   | `keeper show-job` | The selectors matched more than one job; `error.details.candidates` lists them. | Add a narrowing selector (--job-id pins one) or pass --latest to take the most recent. | yes (read-only) |

**Compatibility note:** the bare readers previously emitted
`{success:false, error:"<String(e)>"}` on failure. The `error` field is now the
converged `{code, message, recovery}` object; consumers scraping the old flat
`error` string should read `error.code` (or `error.message`) instead.

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

The host-matrix doctor verbs read `~/.config/keeper/matrix.yaml` (ADR 0010) — the
ordered provider roster that grows the worker model axis beyond claude. They emit
a structured JSON line on stdout (`resolve`'s candidate envelope, `check`'s
findings) and human diagnostics on stderr; neither rides the shared `cli/envelope.ts`
shape. An ABSENT matrix is the claude-only world and never faults — every existing
`keeper agent` behavior stays byte-identical. Reads only; nothing is mutated.

`resolve <model> <effort>` emits `{schema_version, model, effort, driver,
candidates:[{harness, model_id, preset_name}], defaults}` at exit 0. On the
unroutable path it emits `{schema_version, error:"no_route", model, effort,
driver, candidates:[]}`.

| code       | verb                        | meaning                                                                                          | recovery                                                                                 | retry-safe |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------- |
| `no_route` | `agent providers resolve`   | A wrapped (non-claude) model has no configured provider in the roster (empty candidate list).     | Add a provider serving the model to `~/.config/keeper/matrix.yaml`, or correct the token. | yes (read-only) |

Exit codes (distinct from the shared 0/1/2 core, published in `keeper --help --json`):

| exit | verb                      | meaning                                                                                              |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2    | `agent providers resolve` | A model/effort token violates the name charset (lowercase alnum, hyphen, underscore, dot; no leading dot), or the matrix is malformed. |
| 3    | `agent providers resolve` | `no_route` — a wrapped model has no configured provider in the roster. Add a serving provider or correct the model token. |
| 1    | `agent providers check`   | Tool error — the matrix is malformed (ConfigError naming the offense on stderr).                     |
| 9    | `agent providers check`   | One or more roster/preset/reachability drift findings (an unreachable provider binary, or an auto-generated `<provider>-<model>` preset colliding with a hand-authored one); each finding prints one line. |

## Worker-cell launch rejects (`keeper dispatch`, autopilot)

The launcher-owned worker-cell seam (`src/worker-cell.ts`) rejects a doomed
`work` launch BEFORE spawning: the autopilot producer mints a sticky
`DispatchFailed` (cleared by `retry_dispatch`), and manual `keeper dispatch` dies
non-zero (exit 1) with the same reason. These are launch-time reason tokens
(carried in the sticky reason / stderr message), NOT shared-envelope codes.

| code                   | emitted by                    | meaning                                                                                                                | recovery                                                                                                              | retry-safe |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------- |
| `worker-cell-no-route` | autopilot producer, `dispatch` | A WRAPPED cell (a capability model claude does not serve) that the host matrix routes to zero providers, or a malformed `matrix.yaml` at probe time (degraded, never a daemon exit). | Add a provider serving the model to `~/.config/keeper/matrix.yaml` (or fix the matrix), then `keeper retry-dispatch` (autopilot) / re-run (manual). | yes (fix config first) |

Distinct from the run-time `no_route` the `agent providers resolve` verb emits
(above): that is a read-time doctor verdict, this is a launch-time dispatch
reject that parks the task.

## Plan family (`keeper plan` accumulate-all failures)

`plugins/plan/src/emit.ts::emitFailureEnvelope` prints
`{"success": false, "error": {code, message, details, recovery}}` (the plan
`emit()` family is exempt from the shared envelope for Python byte-parity and the
one-JSON-root guard — it converges only on this error sub-object). `details` is a
string list of every issue found; `recovery` is resolved from the code registry
in `emit.ts` (`recoveryForPlanCode`, fallback for an unlisted code). These are
input-validation failures surfaced BEFORE any commit, so re-running after fixing
the input is always safe.

| code                 | meaning                                                        | recovery                                                                    |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bad_yaml`           | The scaffold / refine YAML is malformed.                      | Fix the reported parse or shape error in the input and re-run.              |
| `cell_invalid`       | An `assign-cells` cell set is invalid: an out-of-axis tier/model, or an unknown, duplicate, missing, or non-todo task id (the full-set + todo-only contract). | Correct the cells so every todo task of the epic is covered exactly once with in-axis values, then re-run. |
| `dep_cycle`          | The task dependency graph has a cycle.                        | Break the cycle among the listed tasks, then re-run.                        |
| `dep_invalid`        | A declared task dependency does not resolve.                  | Correct the referenced task id (or remove the edge) and re-run.            |
| `epic_dep_invalid`   | A declared epic dependency does not resolve.                  | Correct the referenced epic id (or remove the edge) and re-run.           |
| `duplicate_epic`     | An epic with this slug already exists.                        | Choose a distinct slug, or pass `--allow-duplicate` to create a sibling.    |
| `id_collision`       | A generated id collides with an existing artifact.           | Re-run with a distinct slug or id.                                          |
| `integrity_failed`   | The post-write integrity check failed; nothing was committed.| Re-run the verb; if it persists, inspect the reported artifacts.           |
| `target_invalid`     | The target id is not well-formed or does not exist.          | Correct the target and re-run.                                             |
| `spec_invalid`       | A task or epic spec field is missing or malformed.          | Fix the reported spec field and re-run.                                    |
| `model_invalid`      | The declared model is not recognized.                        | Set a supported model value and re-run.                                    |
| `tier_invalid`       | The declared tier is out of range.                           | Set a supported tier value and re-run.                                     |
| `repo_invalid`       | The repo path is not a valid git repo root.                 | Correct the repo path and re-run.                                         |
| `missing_session_id` | No session id is available for a mutating verb.             | Ensure the invocation carries a session id and re-run.                    |
| *(unlisted)*         | Any other accumulate-all failure code.                       | Fix the reported problems in the input and re-run; `details` lists them.   |
