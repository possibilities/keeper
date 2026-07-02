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
