/**
 * The shared one-shot JSON envelope for keeper-native CLI commands.
 *
 * Every keeper-native one-shot read/mutate prints ONE
 * `{schema_version, ok, error, data}` value on stdout. `schema_version` is
 * per-verb — the caller injects it — and versions the `data` payload; the
 * envelope KEY SET itself is governed by an additive-only contract (consumers
 * ignore unknown keys; a field name is never repurposed), so there is no second
 * global envelope version int.
 *
 * Exit model (the reference is `cli/status.ts`): a bad board / bad domain state
 * is DATA on an `ok:true` envelope at exit 0. A TRANSPORT failure is an
 * `ok:false` envelope, exit 1 — the envelope still lands on stdout so an agent
 * always parses the last stdout as JSON, never empty stdout + stderr prose. A
 * USAGE / grammar fault (an unknown flag, a bad `--format`, a `--json --format
 * yaml` conflict) is NOT an envelope: it prints help to stderr and exits 2,
 * matching the shared unit-required-grammar / Click exit-2 stance.
 *
 * `error` is `null` on success and `{code, message, recovery}` on failure
 * (RFC 9457 problem-details informs the split):
 *   - `code`     — a stable, machine-matchable problem code (see
 *                  `docs/problem-codes.md`).
 *   - `message`  — a corrective one-line human string, not a diagnostic dump; no
 *                  stack traces and no filesystem paths in an agent-facing error.
 *   - `recovery` — the actionable next step, including retry-safety.
 *
 * EXEMPTIONS — surfaces that deliberately do NOT emit this envelope and must not
 * be migrated onto it:
 *   - the plan `emit()` family (`plugins/plan/src/emit.ts`):
 *     `{success, ...data, plan_invocation}`, frozen for Python byte-parity and
 *     the one-JSON-root guard; it converges only on the error SUB-OBJECT.
 *   - `keeper plan validate`: `{valid, errors, warnings}`, exit 1 on
 *     `valid:false`.
 *   - `keeper plan cat`: raw markdown, format-free.
 *   - `keeper show-session-files`: the snake_case Python-parity payload.
 *   - `keeper watch`: the streaming `{sequence, type, data}` frame shape.
 */

/** The failure sub-object every `ok:false` envelope carries. `details` is an
 *  OPTIONAL structured diagnostic (e.g. an ambiguous read's candidate list) —
 *  additive, mirrors the plan family's converged error object; omitted when
 *  there is nothing structured to carry. */
export interface ProblemError {
  code: string;
  message: string;
  recovery: string;
  details?: unknown;
}

/** The one-shot envelope shape. `data` is the payload on success, `null` on
 *  failure; `error` is the inverse. */
export interface Envelope<D> {
  schema_version: number;
  ok: boolean;
  error: ProblemError | null;
  data: D | null;
}

/** Build a success envelope: `ok:true`, `error:null`, the payload in `data`. */
export function successEnvelope<D>(
  schemaVersion: number,
  data: D,
): Envelope<D> {
  return { schema_version: schemaVersion, ok: true, error: null, data };
}

/** Build a failure envelope: `ok:false`, `data:null`, the problem in `error`. */
export function errorEnvelope(
  schemaVersion: number,
  error: ProblemError,
): Envelope<never> {
  return { schema_version: schemaVersion, ok: false, error, data: null };
}

/** The stdout + exit sink an envelope is emitted through. A CLI's real deps
 *  (`process.stdout.write` + `process.exit`) satisfy it, as does a test harness
 *  that captures the string and records the code. */
export interface EnvelopeSink {
  writeStdout: (s: string) => void;
  exit: (code: number) => never;
}

/** Print the envelope (pretty, trailing newline) on stdout, then exit under the
 *  exit model: `ok:true` → 0, `ok:false` → 1. */
export function emitEnvelope<D>(
  envelope: Envelope<D>,
  sink: EnvelopeSink,
): void {
  sink.writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
  sink.exit(envelope.ok ? 0 : 1);
}

/** Recovery guidance for a daemon-unreachable / connect transport failure —
 *  shared by every read that round-trips the daemon socket. */
export const RECOVERY_DAEMON_DOWN =
  "The keeper daemon did not answer over its socket. Confirm it is running " +
  "(its LaunchAgent restarts it), then retry — this read is retry-safe and " +
  "never mutates state.";

/** Recovery guidance for a keeper.db read failure — shared by the in-binary
 *  bare readers that open keeper.db read-only. A read never mutates, so a retry
 *  is always safe. */
export const RECOVERY_DB_READ =
  "Retry the read — it opens keeper.db read-only and never mutates state. If it " +
  "persists, confirm the keeper daemon is healthy (its LaunchAgent restarts it).";

/** The default stdout + `process.exit` sink for the in-binary one-shot readers.
 *  Tests inject a capturing sink instead (see `test/envelope.test.ts`). */
export const processEnvelopeSink: EnvelopeSink = {
  writeStdout: (s: string) => {
    process.stdout.write(s);
  },
  exit: (code: number): never => process.exit(code),
};
