#!/usr/bin/env bun
/**
 * watch-watchdog — the liveness proof for a keeper:watch standing watch.
 *
 * The keeper:watch skill arms an event-driven watch: a `keeper watch --json`
 * delta tail, a `keeper await needs-human` jam alarm, and the always-on
 * `keeper bus watch` inbox, each a persistent harness Monitor. Those wake
 * sources are anomaly-only emitters, and silence is indistinguishable from
 * death — a daemon bounce or session churn can silently kill a subscription
 * with no error surfaced, so a real signal lands in a dead channel and is
 * missed. This watchdog is the distinct liveness channel that closes that gap:
 * the skill arms it as one more persistent Monitor, passing the EXACT command
 * strings of the sibling monitors it verifies.
 *
 * Each tick it runs three checks and emits a line ONLY on anomaly, debounced at
 * two consecutive misses so a single transient blip never pages:
 *   1. monitors — every sibling command passed via `--monitor` is still running
 *      in THIS session, matched by the SAME exact-equality `keeper await
 *      monitor-running` uses (the shared {@link monitorRunningState}). The skill
 *      generates the armed command and the `--monitor` literal from one string,
 *      so a one-byte drift can never read a live sibling as dead.
 *   2. bus — `keeper bus list` is reachable and shows a live subscribed channel
 *      (a bounce that silently drops every subscription reads as an anomaly).
 *   3. status — `keeper status --json` is reachable and its needs-human
 *      projection is well-formed (the full-state sanity sweep: the surface the
 *      deltas ride is queryable, so a present needs-human row IS being surfaced).
 *
 * Its OWN death is not an anomaly line — it surfaces as the harness Monitor exit
 * notification, the separate liveness channel that keeps anomaly-silence from
 * masking a dead watchdog.
 *
 * Anomaly lines go to stdout (the harness streams them to the supervisor);
 * startup config and self-heal notes go to stderr (diagnostics, never the event
 * channel), so stdout stays strictly anomaly-only.
 *
 * Usage:
 *   bun scripts/watch-watchdog.ts --monitor '<cmd>' [--monitor '<cmd>']...
 *   bun scripts/watch-watchdog.ts --monitor '<cmd>' --interval 30s
 *   bun scripts/watch-watchdog.ts --help
 *
 * Options:
 *   --monitor <cmd>   Exact command string of a sibling monitor to verify alive
 *                     (repeatable). MUST byte-match the string the Monitor was
 *                     armed with — the match is exact equality, never substring.
 *   --interval <dur>  Poll cadence (default 30s; unit required, e.g. 30s / 5m).
 *   --max-ticks <n>   Stop after N ticks (0 = run forever, the production
 *                     default). Bounds a smoke run.
 *   --no-bus          Skip the bus-presence check.
 *   --sock <path>     Socket override, forwarded to every keeper subcommand
 *                     ($KEEPER_SOCK / default otherwise).
 *   --help            Show this help.
 */

import { parseArgs } from "node:util";
import { parseDuration } from "../cli/duration";
import {
  type MonitorSelector,
  monitorRunningState,
} from "../src/await-conditions";
import type { Job } from "../src/types";

const HELP = `watch-watchdog — liveness proof for a keeper:watch standing watch

Usage:
  bun scripts/watch-watchdog.ts --monitor '<cmd>' [--monitor '<cmd>']... [flags]

Arms as a persistent Monitor alongside the keeper:watch delta tail, jam alarm,
and bus inbox. Each tick verifies those siblings are still live and the daemon's
needs-human surface is reachable; emits a line ONLY on anomaly, debounced at two
consecutive misses. Its own death surfaces as the harness Monitor exit
notification (the distinct liveness channel).

Options:
  --monitor <cmd>   Exact command string of a sibling monitor to verify alive
                    (repeatable). Byte-matches the armed command (exact equality,
                    never substring) — pass the SAME literal used to arm it.
  --interval <dur>  Poll cadence (default 30s; unit required, e.g. 30s / 5m).
  --max-ticks <n>   Stop after N ticks (0 = forever, the production default).
  --no-bus          Skip the bus-presence check.
  --sock <path>     Socket override forwarded to each keeper subcommand.
  --help            Show this help.

Anomaly lines (stdout):
  [watch-watchdog] anomaly check=<monitors|bus|status> misses=2 detail=<...>
`;

/** Consecutive misses before an anomaly line fires (silence-is-death debounce
 *  lore: a lone transient blip never pages; two in a row is real). */
const DEBOUNCE_MISSES = 2;

/** Per-subcommand probe timeout (ms). Mirrors the sibling scripts' round-trip
 *  cap so a wedged daemon can't hang a tick. */
const PROBE_TIMEOUT_MS = 5000;

/** Default poll cadence when `--interval` is omitted. */
const DEFAULT_INTERVAL_MS = 30_000;

type CheckName = "monitors" | "bus" | "status";
const CHECK_NAMES: readonly CheckName[] = ["monitors", "bus", "status"];

/** One check's verdict this tick. */
interface CheckResult {
  ok: boolean;
  detail: string;
}

/** Strip CR/LF so an embedded newline in an operator-passed command or an
 *  attacker-influenced reason string can't spoof an adjacent anomaly line. */
function sanitize(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

interface Parsed {
  monitors: string[];
  intervalMs: number;
  maxTicks: number;
  bus: boolean;
  sock: string | null;
}

export function parseArgv(
  argv: string[],
): Parsed | { help: true } | { error: string } {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        monitor: { type: "string", multiple: true },
        interval: { type: "string" },
        "max-ticks": { type: "string" },
        bus: { type: "boolean", default: true },
        "no-bus": { type: "boolean", default: false },
        sock: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  if (values.help === true) {
    return { help: true };
  }

  const monitors = Array.isArray(values.monitor)
    ? (values.monitor as string[]).filter((m) => m.length > 0)
    : [];
  if (monitors.length === 0) {
    return { error: "at least one --monitor <cmd> is required" };
  }

  let intervalMs = DEFAULT_INTERVAL_MS;
  if (typeof values.interval === "string" && values.interval.length > 0) {
    const d = parseDuration(values.interval);
    if (!d.ok) {
      return { error: `--interval ${d.message}` };
    }
    intervalMs = d.ms;
  }

  let maxTicks = 0;
  if (typeof values["max-ticks"] === "string") {
    const n = Number(values["max-ticks"]);
    if (!Number.isInteger(n) || n < 0) {
      return {
        error: `--max-ticks must be a non-negative integer (got '${values["max-ticks"]}')`,
      };
    }
    maxTicks = n;
  }

  return {
    monitors,
    intervalMs,
    maxTicks,
    // `--no-bus` is registered as its own boolean (node:util's `parseArgs`
    // does not auto-negate a `bus`-named option into a `--no-bus` flag) —
    // either it or an explicit `--bus false`-style false turns the check off.
    bus: values.bus !== false && values["no-bus"] !== true,
    sock: typeof values.sock === "string" ? (values.sock as string) : null,
  };
}

/** Run `keeper <args> --json`, bounded by {@link PROBE_TIMEOUT_MS}, and parse the
 *  stdout envelope. Returns the parsed JSON on success, or an error string on a
 *  non-zero exit / timeout / malformed output — every failure counts as a check
 *  miss (the surface is unreachable, which is exactly what the watchdog exists to
 *  catch). `keeper` is on PATH wherever keeper:watch operates (its sibling
 *  monitors are `keeper watch` / `keeper await`). */
async function keeperJson(
  args: string[],
  sock: string | null,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const full = [...args, "--json", ...(sock !== null ? ["--sock", sock] : [])];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["keeper", ...full], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${(err as Error).message}` };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // best-effort — the exit await resolves either way.
    }
  }, PROBE_TIMEOUT_MS);
  let exitCode: number;
  let text: string;
  try {
    // Drain BOTH pipes CONCURRENTLY with the exit await, never sequentially
    // after it — a child whose output exceeds the OS pipe buffer blocks on
    // write while a parent that awaits `proc.exited` first blocks on read, a
    // backpressure deadlock (`keeper query jobs` on a busy board can exceed
    // it on stdout; a noisy stderr writer re-seats the exact same class on
    // the sibling pipe). stderr's text is discarded — this probe only surfaces
    // stdout's JSON envelope — but it MUST still be read concurrently so its
    // pipe never backs up.
    const [stdoutText, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    text = stdoutText;
    exitCode = code;
  } catch (err) {
    return {
      ok: false,
      error: `read stdout failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0) {
    return { ok: false, error: `keeper ${args.join(" ")} exited ${exitCode}` };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, error: `malformed json from keeper ${args.join(" ")}` };
  }
}

/**
 * monitors check: every `--monitor` command is still running in THIS session.
 * Reuses the authoritative {@link monitorRunningState} (the exact-equality match
 * `keeper await monitor-running` uses) so the watchdog can never drift from what
 * counts as "still running". A `waiting` verdict means ≥1 matching entry is live;
 * anything else means the sibling is gone — but only once the own job row is
 * itself verifiable: an absent row or a null `monitors` snapshot (the arming
 * turn's Stop hook hasn't written it yet) is "cannot verify yet", NOT "dead",
 * and is checked directly here rather than through `monitorRunningState` (whose
 * `met` verdict conflates both cases).
 */
/**
 * Pure classification over an already-fetched `Job[]` snapshot — factored out
 * of {@link checkMonitors} so the unverifiable-own-job branch (the epic's
 * headline fix) and the dead-sibling path are both directly testable without
 * a real subprocess. No I/O, no `Date.now()`.
 */
export function classifyMonitors(
  monitors: string[],
  ownSessionId: string,
  rows: readonly Job[],
): CheckResult {
  const ownJob = rows.find((j) => j.job_id === ownSessionId);
  if (ownJob === undefined || ownJob.monitors === null) {
    // Own job row not yet in the projection, or its `monitors` snapshot is
    // still null (only the arming turn's Stop hook writes it) — unverifiable,
    // NOT dead. `monitorRunningState` folds both into the same `met` verdict
    // as a truly-absent sibling; distinguish here rather than false-paging
    // every armed watch in the arm window (mirrors the ownSessionId===null
    // degrade in {@link checkMonitors}).
    return {
      ok: true,
      detail:
        "own job row unverifiable (absent or monitors unset) — monitor check skipped",
    };
  }
  const dead: string[] = [];
  for (const command of monitors) {
    const selector: MonitorSelector = { command };
    // `waiting` == still running (≥1 matching entry). Any other verdict (`met`)
    // == no matching monitor == the sibling is gone.
    const st = monitorRunningState(ownSessionId, selector, rows);
    if (st.kind !== "waiting") {
      dead.push(command);
    }
  }
  if (dead.length > 0) {
    return {
      ok: false,
      detail: `sibling monitor(s) not running: ${dead.join(" | ")}`,
    };
  }
  return { ok: true, detail: `${monitors.length} sibling monitor(s) live` };
}

async function checkMonitors(
  monitors: string[],
  ownSessionId: string | null,
  sock: string | null,
): Promise<CheckResult> {
  if (ownSessionId === null) {
    // No own-session id to scope the jobs row → can't tell a live sibling from a
    // dead one. Never emit a false anomaly; degrade to unverifiable (a stderr
    // note fired once at startup) and hold this check green.
    return { ok: true, detail: "own session id unset — monitor check skipped" };
  }
  const res = await keeperJson(["query", "jobs"], sock);
  if (!res.ok) {
    return { ok: false, detail: `jobs unreachable: ${res.error}` };
  }
  const data = (res.json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { ok: false, detail: "jobs query returned no rows array" };
  }
  return classifyMonitors(monitors, ownSessionId, data as Job[]);
}

/**
 * bus check: the bus is reachable and carries a live subscribed channel. The
 * channel list carries no session id, so this is a bus-subsystem liveness proof
 * (a bounce that silently drops every subscription reads as anomaly); the
 * per-session inbox liveness is covered exactly by passing `keeper bus watch` as
 * one of the `--monitor` commands (the monitors check).
 */
async function checkBus(sock: string | null): Promise<CheckResult> {
  const res = await keeperJson(["bus", "list"], sock);
  if (!res.ok) {
    return { ok: false, detail: `bus unreachable: ${res.error}` };
  }
  const channels = res.json;
  if (!Array.isArray(channels)) {
    return { ok: false, detail: "bus list returned no channel array" };
  }
  const subscribed = channels.filter(
    (c) => (c as { subscribed?: unknown }).subscribed === true,
  );
  if (subscribed.length === 0) {
    return { ok: false, detail: "no subscribed bus channels" };
  }
  return { ok: true, detail: `${subscribed.length} subscribed channel(s)` };
}

/**
 * status check (full-state sanity sweep): `keeper status --json` is reachable and
 * its needs-human projection is well-formed. A present needs-human row is NOT an
 * anomaly — it is exactly what the deltas surface — so the check verifies the
 * surface is queryable, not that any particular count is zero.
 */
async function checkStatus(sock: string | null): Promise<CheckResult> {
  const res = await keeperJson(["status"], sock);
  if (!res.ok) {
    return { ok: false, detail: `status unreachable: ${res.error}` };
  }
  const data = (res.json as { data?: { needs_human?: unknown } }).data;
  const nh = data?.needs_human as { total?: unknown } | undefined;
  if (nh === undefined || typeof nh.total !== "number") {
    return { ok: false, detail: "status needs_human projection malformed" };
  }
  return { ok: true, detail: `needs_human.total=${nh.total}` };
}

export interface WatchdogDeps {
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
  runCheck: (name: CheckName) => Promise<CheckResult>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * The debounced watch loop, factored out of {@link main} so its emit discipline
 * is driven without real subprocesses / wall-clock. Each check tracks its own
 * consecutive-miss counter: an anomaly line fires the instant the counter REACHES
 * {@link DEBOUNCE_MISSES} (never re-fired while it stays down — the line only
 * re-arms after a recovery resets the counter), so a wrong sibling produces
 * exactly one debounced anomaly line. A recovery resets silently (a stderr note
 * only), keeping stdout strictly anomaly-only.
 */
export async function runWatchdogLoop(
  deps: WatchdogDeps,
  opts: { intervalMs: number; maxTicks: number; checks: readonly CheckName[] },
): Promise<void> {
  const misses: Record<CheckName, number> = { monitors: 0, bus: 0, status: 0 };
  const reported: Record<CheckName, boolean> = {
    monitors: false,
    bus: false,
    status: false,
  };
  let tick = 0;
  for (;;) {
    for (const name of opts.checks) {
      const result = await deps.runCheck(name);
      if (result.ok) {
        if (reported[name]) {
          deps.writeStderr(`[watch-watchdog] recovered check=${name}`);
        }
        misses[name] = 0;
        reported[name] = false;
        continue;
      }
      misses[name] += 1;
      if (misses[name] === DEBOUNCE_MISSES) {
        deps.writeStdout(
          `[watch-watchdog] anomaly check=${name} misses=${misses[name]} detail=${sanitize(result.detail)}`,
        );
        reported[name] = true;
      }
    }
    tick += 1;
    if (opts.maxTicks > 0 && tick >= opts.maxTicks) {
      return;
    }
    await deps.sleep(opts.intervalMs);
  }
}

/** Derive the tick's check list from the parsed `--no-bus` flag — the exact
 *  wiring `main` applies. Factored out (rather than inlined in `main`) so
 *  the flag-to-filter mapping is directly testable without booting `main`'s
 *  real subprocess loop. */
export function deriveChecks(bus: boolean): CheckName[] {
  return bus ? [...CHECK_NAMES] : CHECK_NAMES.filter((c) => c !== "bus");
}

async function main(): Promise<void> {
  const parsed = parseArgv(Bun.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return;
  }
  if ("error" in parsed) {
    process.stderr.write(`[watch-watchdog] ${parsed.error}\n\n${HELP}`);
    process.exit(1);
  }

  const ownSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const checks: CheckName[] = deriveChecks(parsed.bus);

  process.stderr.write(
    `[watch-watchdog] armed monitors=${parsed.monitors.length} interval=${parsed.intervalMs}ms bus=${parsed.bus ? "on" : "off"} session=${ownSessionId ?? "none"}\n`,
  );
  if (ownSessionId === null) {
    process.stderr.write(
      "[watch-watchdog] CLAUDE_CODE_SESSION_ID unset — monitor liveness cannot be scoped; that check is skipped\n",
    );
  }

  await runWatchdogLoop(
    {
      writeStdout: (line) => process.stdout.write(`${line}\n`),
      writeStderr: (line) => process.stderr.write(`${line}\n`),
      runCheck: (name) => {
        if (name === "monitors") {
          return checkMonitors(parsed.monitors, ownSessionId, parsed.sock);
        }
        if (name === "bus") {
          return checkBus(parsed.sock);
        }
        return checkStatus(parsed.sock);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { intervalMs: parsed.intervalMs, maxTicks: parsed.maxTicks, checks },
  );
}

if (import.meta.main) {
  await main();
}
