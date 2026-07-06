/**
 * The keeper→`uv`→agentusage-util→JSON scrape seam (fn-930 `.3`).
 *
 * This is the thin boundary the usage-scraper worker (`.4`) stands on: it shells
 * the stateless one-shot agentusage scrape util through an absolute `uv`,
 * captures stdout, and parses + validates the discriminated `{ok|error}` JSON
 * contract the util prints. The ENVELOPE assembly (multiplier, next_fetch_at,
 * last_*_fetch_at, lift_at carry — all producer-side wall-clock) is the worker's
 * job, NOT this seam's; this layer owns only the scrape round-trip.
 *
 * Injectable-runner pattern (mirrors `GitRunner` in `src/commit-work/git-exec.ts`
 * and the `SessionStateDeps`/`buildSessionState` seam): production threads the
 * real {@link spawnScrape}; unit tests pass a synthetic {@link ScrapeRunner}
 * returning canned JSON so the worker's branch logic (ok / no_subscription /
 * error / schema mismatch) is exercised in-process with NO real `uv`/PTY. A plain
 * function param — no DI framework.
 *
 * Spawn discipline (the keystone risks this task de-risks):
 *  - stdout is DRAINED CONCURRENTLY with `proc.exited` via `Promise.all` — never
 *    await-then-read, which deadlocks once the util's stdout exceeds the ~64KB
 *    pipe buffer (a big `screen_excerpt` on a parse-drift error can approach it).
 *  - bounded by a manual `setTimeout` → `proc.kill("SIGKILL")` deadline
 *    (`AbortSignal.timeout()` mis-fires on Bun/macOS, bun#7512), so a hung PTY
 *    scrape can never wedge a worker loop.
 *  - stderr is drained separately (the util sends ALL diagnostics/tracebacks
 *    there) and surfaced on the failure arms for diagnosis.
 *  - the `cwd` is set to the agentusage project dir so `python -m
 *    agentusage.scrape_cli` resolves the package; `uv run --directory <dir>`
 *    additionally pins the project env under keeperd's stripped LaunchAgent PATH.
 *    Plain `run` — NEVER `--python <path>`, which recreates the venv every call
 *    (uv#11288).
 *
 * No `bun:sqlite` import — this is a db-free leaf shelled from the worker.
 */

import { dirname, isAbsolute, join } from "node:path";
import { resolveTmuxBin } from "./agent/tmux-launch";
import { resolveUsageScraperRuntime, type UsageScraperRuntime } from "./db";

/** Schema version the util stamps on every JSON object; the worker gates on it. */
export const SCRAPE_CONTRACT_SCHEMA_VERSION = 1;

/** Default per-scrape wall-clock budget. A real `/usage` PTY scrape settles well
 *  inside this; past it the child is SIGKILLed and the timeout arm returned. */
export const DEFAULT_SCRAPE_TIMEOUT_MS = 60_000;

/** Scrape target — the two TUIs the util knows how to render + parse. */
export type ScrapeTarget = "claude" | "codex";

/** One account to scrape: which TUI + which profile (claude) / ignored (codex). */
export interface ScrapeAccount {
  target: ScrapeTarget;
  /** Account/profile name; the util maps it onto `CLAUDE_CONFIG_DIR` for claude. */
  profile: string;
  /** Optional binary override forwarded as `--command` (tests / non-default install). */
  command?: string;
  /** Optional PTY geometry overrides forwarded as `--rows`/`--cols`. */
  rows?: number;
  cols?: number;
}

/** One usage window the parser emits: percent used + the reset instant (if any). */
export interface UsageWindow {
  percent_used: number | null;
  resets_at: string | null;
}

/** The `usage` sub-object on the ok/subscribed arm. */
export interface ScrapeUsage {
  session?: UsageWindow;
  week?: UsageWindow;
  /** Claude-only Sonnet weekly bucket. */
  sonnet_week?: UsageWindow;
  /** Codex-only GPT-5.3-Codex-Spark 5h bucket. */
  codex_spark_session?: UsageWindow;
  /** Codex-only GPT-5.3-Codex-Spark weekly bucket. */
  codex_spark_week?: UsageWindow;
}

/**
 * Stable keeper-side failure classification carried on a stale `usage` row's
 * `error_kind` — separates WHAT kind of failure is blocking usage freshness so
 * the renderer (and a human) can tell scraper/runner faults apart from target
 * TUI format drift. Five stable values:
 *  - `format_changed`  — the target TUI rendered but didn't match the expected
 *                        shape (claude/codex parser drift).
 *  - `panel_missing`   — the usage/status panel never rendered (no parseable
 *                        content); distinct from format drift.
 *  - `scrape_failed`   — the scrape itself crashed (binary missing, TUI spawn
 *                        fault, unexpected crash before/while rendering).
 *  - `upstream_limited`— the target reported its OWN usage endpoint is throttled
 *                        (claude `/usage` endpoint rate limit); transient.
 *  - `runner_failed`   — keeper's scrape SEAM could not obtain a contract at all
 *                        (spawn/timeout/empty/non-JSON/schema-mismatch). Minted
 *                        keeper-side, never by the util.
 *
 * The util (v2 contract) emits one of the first four on its `error` arm; keeper
 * mints `runner_failed` on the runner_failure arm and falls back to a derived
 * kind when an older (v1) util emits an `error` arm with no `error_kind`.
 */
export type UsageErrorKind =
  | "format_changed"
  | "panel_missing"
  | "scrape_failed"
  | "upstream_limited"
  | "runner_failed";

const USAGE_ERROR_KINDS: ReadonlySet<string> = new Set<UsageErrorKind>([
  "format_changed",
  "panel_missing",
  "scrape_failed",
  "upstream_limited",
  "runner_failed",
]);

/**
 * Coerce an unknown (a contract field, an envelope cell) to a {@link UsageErrorKind}
 * or null. An unknown/absent value folds to null so a v1 contract (no
 * `error_kind`) and any future/garbage value both stay safe — the worker's
 * fallback classifier supplies the kind in that case.
 */
export function asUsageErrorKind(v: unknown): UsageErrorKind | null {
  return typeof v === "string" && USAGE_ERROR_KINDS.has(v)
    ? (v as UsageErrorKind)
    : null;
}

/**
 * Orthogonal account-state axis — the stable "why are there no quota bars"
 * reason that is independent of freshness (`status`) and scrape-failure class
 * (`error_kind`). NULL ≡ a subscribed (or codex) account with nothing to flag.
 *
 *  - `signed_out`       — the profile is logged out; no subscription signal is
 *                         knowable (distinct from a confirmed no-subscription).
 *  - `no_subscription`  — logged in, but the account carries no active plan.
 *
 * Keeper-derived and written ONLY to the on-disk envelope (NOT a scrape_cli wire
 * field), so `SCRAPE_CONTRACT_SCHEMA_VERSION` does not bump.
 */
export type AccountState = "signed_out" | "no_subscription";

const USAGE_ACCOUNT_STATES: ReadonlySet<string> = new Set<AccountState>([
  "signed_out",
  "no_subscription",
]);

/**
 * Coerce an unknown (a contract field, an envelope cell) to an {@link AccountState}
 * or null. An unknown/absent/garbage value folds to null so a pre-feature envelope
 * and any future value both stay safe — keeping the fold re-fold-deterministic.
 */
export function asAccountState(v: unknown): AccountState | null {
  return typeof v === "string" && USAGE_ACCOUNT_STATES.has(v)
    ? (v as AccountState)
    : null;
}

/**
 * The util's discriminated JSON contract, parsed + validated. EXACTLY one of:
 *  - `ok` (subscribed): carries `usage` + `subscription_active` (true for claude,
 *    null for codex).
 *  - `ok` (no_subscription): the claude NoActiveSubscription SUCCESS arm — its
 *    `no_subscription:true` presence IS the signal; no `usage`.
 *  - `ok` (signed_out): the claude logged-out SUCCESS arm — its `signed_out:true`
 *    presence IS the signal; no `usage`, no subscription signal. Additive arm
 *    (keeper parses it ahead of the agentusage emitter shipping it).
 *  - `error`: parse drift / panel-never-rendered / scrape crash — carries
 *    `error_type`, `message`, `screen_excerpt` (head+tail-elided rendered lines),
 *    and (v2) a stable `error_kind`. An older v1 util omits `error_kind`, which
 *    parses to null and lets the worker derive a fallback kind.
 *  - `runner_failure`: the SEAM could not even obtain a valid contract (spawn
 *    failure, timeout/SIGKILL, empty stdout, non-JSON, schema mismatch). This arm
 *    is minted HERE, never by the util — it carries the captured stderr +
 *    diagnostic so the worker writes `stale` + `.error.json` without crash-looping.
 */
export type ScrapeResult =
  | {
      kind: "ok";
      no_subscription: false;
      usage: ScrapeUsage;
      subscription_active: boolean | null;
    }
  | { kind: "ok"; no_subscription: true }
  | { kind: "ok"; signed_out: true }
  | {
      kind: "error";
      error_type: string;
      message: string;
      screen_excerpt: string[];
      /** v2 contract classification; null when an older v1 util omitted it. */
      error_kind: UsageErrorKind | null;
    }
  | {
      kind: "runner_failure";
      /** Stable reason tag for the worker's branch + logging. */
      reason:
        | "spawn_failed"
        | "timed_out"
        | "empty_stdout"
        | "non_json"
        | "schema_mismatch"
        | "bad_shape";
      message: string;
      /** Captured stderr (tracebacks / uv diagnostics), trimmed for logging. */
      stderr: string;
      /** Child exit code when the process ran to completion, else null. */
      exitCode: number | null;
    };

/**
 * The function shape the worker depends on for one scrape. Production threads
 * {@link spawnScrape}; tests inject a fake returning a canned {@link ScrapeResult}.
 */
export type ScrapeRunner = (account: ScrapeAccount) => Promise<ScrapeResult>;

/**
 * Build the FULL argv (binary + args) for one scrape, per the resolved runtime.
 *  - `uv`: `<uv> run --directory <dir> python -m agentusage.scrape_cli …` — plain
 *    `run` sets the child cwd + pins the project env; NEVER `--python` (uv#11288
 *    recreates the venv per call).
 *  - `bun`: `<bun> <dir>/src/scrape-cli.ts …` — the agentusage bun entry under the
 *    same project dir.
 * Both thread an identical `--target`/`--profile` (+ optional
 * `--command`/`--rows`/`--cols`) tail, so a flip changes only the launcher, not
 * the request shape.
 */
export function buildScrapeArgs(
  runtime: UsageScraperRuntime,
  account: ScrapeAccount,
): string[] {
  const tail = ["--target", account.target, "--profile", account.profile];
  if (account.command !== undefined) {
    tail.push("--command", account.command);
  }
  if (account.rows !== undefined) {
    tail.push("--rows", String(account.rows));
  }
  if (account.cols !== undefined) {
    tail.push("--cols", String(account.cols));
  }
  if (runtime.runtime === "bun") {
    return [
      runtime.bunPath,
      join(runtime.projectDir, "src", "scrape-cli.ts"),
      ...tail,
    ];
  }
  return [
    runtime.uvPath,
    "run",
    "--directory",
    runtime.projectDir,
    "python",
    "-m",
    "agentusage.scrape_cli",
    ...tail,
  ];
}

/**
 * Parse + validate the util's stdout into a {@link ScrapeResult}. Pure over its
 * inputs (no spawn) so unit tests drive every arm directly. A blank/non-JSON
 * stdout, a wrong `schema_version`, or a shape that matches no arm folds to a
 * `runner_failure` rather than throwing — a transient scrape must never crash the
 * worker loop.
 */
export function parseScrapeStdout(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): ScrapeResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    // Bun#24690: empty stdout read back inside a Worker. The util flushes, so a
    // genuine empty read here is a runtime/spawn fault, not a contract.
    return {
      kind: "runner_failure",
      reason: "empty_stdout",
      message: "scrape util produced empty stdout",
      stderr: clampStderr(stderr),
      exitCode,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      kind: "runner_failure",
      reason: "non_json",
      message: "scrape util stdout was not valid JSON",
      stderr: clampStderr(stderr),
      exitCode,
    };
  }
  if (!isRecord(parsed)) {
    return {
      kind: "runner_failure",
      reason: "bad_shape",
      message: "scrape util JSON was not an object",
      stderr: clampStderr(stderr),
      exitCode,
    };
  }
  if (parsed.schema_version !== SCRAPE_CONTRACT_SCHEMA_VERSION) {
    return {
      kind: "runner_failure",
      reason: "schema_mismatch",
      message: `scrape contract schema_version ${String(
        parsed.schema_version,
      )} != expected ${SCRAPE_CONTRACT_SCHEMA_VERSION}`,
      stderr: clampStderr(stderr),
      exitCode,
    };
  }
  const status = parsed.status;
  if (status === "ok") {
    // Check signed_out BEFORE no_subscription and the usage check: a logged-out
    // profile carries no usage and no subscription signal, so it must not be
    // mistaken for a no-subscription account or fall through to bad_shape.
    if (parsed.signed_out === true) {
      return { kind: "ok", signed_out: true };
    }
    if (parsed.no_subscription === true) {
      return { kind: "ok", no_subscription: true };
    }
    if (isRecord(parsed.usage)) {
      const sa = parsed.subscription_active;
      return {
        kind: "ok",
        no_subscription: false,
        usage: parsed.usage as ScrapeUsage,
        subscription_active: sa === true ? true : sa === false ? false : null,
      };
    }
    return {
      kind: "runner_failure",
      reason: "bad_shape",
      message: "ok status missing both usage and no_subscription",
      stderr: clampStderr(stderr),
      exitCode,
    };
  }
  if (status === "error") {
    return {
      kind: "error",
      error_type:
        typeof parsed.error_type === "string" ? parsed.error_type : "Unknown",
      message: typeof parsed.message === "string" ? parsed.message : "",
      screen_excerpt: Array.isArray(parsed.screen_excerpt)
        ? parsed.screen_excerpt.filter(
            (l): l is string => typeof l === "string",
          )
        : [],
      // v2: a stable classification; absent on a v1 contract → null (the worker
      // derives a fallback kind from error_type then).
      error_kind: asUsageErrorKind(parsed.error_kind),
    };
  }
  return {
    kind: "runner_failure",
    reason: "bad_shape",
    message: `scrape contract status was ${String(status)}`,
    stderr: clampStderr(stderr),
    exitCode,
  };
}

/** Bound stderr captured for logging so a huge traceback never balloons a log line. */
function clampStderr(stderr: string, max = 4_000): string {
  const t = stderr.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (${t.length - max} more)`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Options for {@link spawnScrape} — the resolved runtime + the per-call budget. */
export interface SpawnScrapeOptions {
  /** The resolved runtime (uv|bun): binary + project dir + which argv shape. */
  runtime: UsageScraperRuntime;
  timeoutMs?: number;
  /** Extra env merged over `process.env` for the child (e.g. `PATH`, `CLAUDE_CONFIG_DIR`). */
  env?: Record<string, string>;
}

/**
 * Run ONE scrape as a real `uv` subprocess and return the parsed contract. Drains
 * stdout + stderr CONCURRENTLY with `proc.exited`, bounds the run with a manual
 * SIGKILL deadline, and parses the result. NEVER throws — a spawn failure /
 * timeout / non-contract output folds to a `runner_failure` arm so the worker
 * stays in its no-throw cycle.
 */
export async function spawnScrape(
  account: ScrapeAccount,
  opts: SpawnScrapeOptions,
): Promise<ScrapeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS;
  const argv = buildScrapeArgs(opts.runtime, account);
  // `const proc` (spawned INSIDE the try) keeps Bun.spawn's NARROWED stream
  // types — a pre-declared widened annotation erases them to the
  // `number | ReadableStream` union and breaks `new Response`. Bun.spawn throws
  // SYNCHRONOUSLY on a bad binary, so a spawn failure lands in the same catch.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(argv, {
      // cwd at the project dir keeps module resolution correct (redundant with
      // uv's `--directory`, load-bearing for the bun entry's relative imports).
      cwd: opts.runtime.projectDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });

    let timedOut = false;
    // Manual deadline — AbortSignal.timeout() mis-fires on Bun/macOS (bun#7512).
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    // Drain BOTH pipes concurrently with `exited`. Awaiting stdout fully before
    // reading stderr (or vice-versa) deadlocks on a child whose other pipe fills
    // its ~64KB buffer mid-run — the same backpressure hazard the git-exec drain
    // calls out, and the util's `screen_excerpt` can be large on a parse drift.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      return {
        kind: "runner_failure",
        reason: "timed_out",
        message: `scrape exceeded ${timeoutMs}ms budget (SIGKILLed)`,
        stderr: clampStderr(stderr),
        exitCode,
      };
    }
    return parseScrapeStdout(stdout, stderr, exitCode);
  } catch (err) {
    // A synchronous spawn failure (bad uv path) or an unexpected drain rejection
    // — never throw past the seam; fold to runner_failure so the worker loop
    // stays in its no-throw cycle.
    return {
      kind: "runner_failure",
      reason: "spawn_failed",
      message: `scrape spawn/drain failed: ${String(err)}`,
      stderr: "",
      exitCode: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The default production {@link ScrapeRunner}. Gates on
 * {@link resolveUsageScraperRuntime}: if the absolute `uv` path + agentusage
 * project dir do not BOTH resolve, returns a `spawn_failed` runner_failure rather
 * than spawning — the worker (`.4`) checks the runtime resolves BEFORE arming its
 * loop, so this guard is the belt-and-suspenders second line, never the gate.
 */
export const runScrape: ScrapeRunner = async (account) => {
  const runtime = resolveUsageScraperRuntime();
  if (runtime === null) {
    return {
      kind: "runner_failure",
      reason: "spawn_failed",
      message: "usage-scraper runtime unresolved (project dir / uv path unset)",
      stderr: "",
      exitCode: null,
    };
  }
  // Both legs spawn `tmux` to drive the target TUI; launchd strips PATH, so the
  // child needs tmux's directory injected or the scrape ENOENTs. Append (never
  // prepend) so an operator PATH still wins.
  return spawnScrape(account, {
    runtime,
    env: { PATH: scrapeChildPath(process.env.PATH) },
  });
};

/**
 * Append `tmux`'s resolved directory to the inherited PATH for a scrape child,
 * so a bun/uv scrape can spawn tmux even under launchd's stripped PATH. A bare
 * (unresolvable) tmux is left off — the scrape then ENOENTs loudly rather than
 * polluting PATH with `.`.
 */
function scrapeChildPath(basePath: string | undefined): string {
  const tmuxBin = resolveTmuxBin(process.env);
  if (!isAbsolute(tmuxBin)) {
    return basePath ?? "";
  }
  return withDirOnPath(basePath, dirname(tmuxBin));
}

/** Pure: append `dir` to a `:`-delimited PATH string unless already present. */
export function withDirOnPath(
  basePath: string | undefined,
  dir: string,
): string {
  const base = basePath ?? "";
  if (base.length === 0) {
    return dir;
  }
  return base.split(":").includes(dir) ? base : `${base}:${dir}`;
}
