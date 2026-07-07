#!/usr/bin/env bun
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import {
  ClaudeUsageEndpointRateLimited,
  NoActiveSubscription,
  PANEL_HEADER,
  parse as parseClaude,
  SignedOut,
} from "./parse-claude-usage";
import { PANEL_SENTINEL, parse as parseCodex } from "./parse-codex-status";
import { scrape, TARGETS } from "./scrape";

/**
 * Stateless one-shot scrape CLI — scrape+parse ONLY, no state, no orchestration.
 *
 *     bun src/usage-scrape/scrape-cli.ts --target <claude|codex> \
 *         --profile <name> [--command <path>] [--rows N] [--cols M]
 *
 * Prints ONE discriminated JSON object on stdout; ALL diagnostics / stack traces
 * go to stderr. The four contract arms and their exit codes:
 *
 *     ok (subscribed)      {schema_version, status:"ok", usage, subscription_active}   0
 *     ok (no_subscription) {schema_version, status:"ok", no_subscription:true}         0
 *     ok (signed_out)      {schema_version, status:"ok", signed_out:true}              0
 *     error                {schema_version, status:"error", error_kind, error_type,
 *                           message, screen_excerpt}                                   1
 *
 * The no_subscription / signed_out arms OMIT `usage` and `subscription_active`
 * entirely — the presence of their flag IS the signal, and keeper folds a scrape
 * to runner_failure if that key presence is wrong. `subscription_active` is true
 * for subscribed claude, null for codex (no subscription concept).
 */

// The keeper worker gates on this integer; it is independent of the on-disk
// envelope schema version. `error_kind` ships as an additive optional field
// under v1 (keeper coerces an absent kind to null).
export const SCHEMA_VERSION = 1;

// Stable error-arm classification vocabulary — the language seam keeper's
// UsageErrorKind union keys on. keeper mints `runner_failed` itself; this util
// emits exactly these four.
export const ERROR_KIND_SCRAPE_FAILED = "scrape_failed";
export const ERROR_KIND_UPSTREAM_LIMITED = "upstream_limited";
export const ERROR_KIND_FORMAT_CHANGED = "format_changed";
export const ERROR_KIND_PANEL_MISSING = "panel_missing";

type Target = "claude" | "codex";
type ParseFn = (text: string, now?: Temporal.ZonedDateTime) => unknown;

export const PARSERS: Record<Target, ParseFn> = {
  claude: parseClaude,
  codex: parseCodex,
};

// ---------- now resolution --------------------------------------------------

const OFFSET_RE = /([+-]\d{2}:?\d{2}|Z)$/;

/** Extract the argv offset as a fixed-offset zone id, mirroring parse-bridge. */
function offsetZoneFrom(nowArg: string): string {
  const m = OFFSET_RE.exec(nowArg);
  if (!m) {
    throw new Error(`AGENTUSAGE_NOW must carry a UTC offset: '${nowArg}'`);
  }
  const off = m[1];
  if (off === "Z") {
    return "+00:00";
  }
  return off.includes(":") ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
}

/**
 * Build the parsers' `now` from `AGENTUSAGE_NOW` (offset-bearing ISO), or
 * undefined to let each parser default to the wall clock. Per-target zoning
 * mirrors parse-bridge: claude reprojects the resolved reset to the system zone,
 * so it needs a real IANA zone; codex keeps `now`'s own fixed offset (never
 * reprojecting).
 */
function buildNow(
  target: Target,
  nowArg: string | undefined,
): Temporal.ZonedDateTime | undefined {
  if (nowArg === undefined) {
    return undefined;
  }
  const instant = Temporal.Instant.from(nowArg);
  if (target === "claude") {
    return instant.toZonedDateTimeISO(Temporal.Now.timeZoneId());
  }
  return instant.toZonedDateTimeISO(offsetZoneFrom(nowArg));
}

// ---------- payload builders ------------------------------------------------

function okSubscribed(
  usage: unknown,
  subscriptionActive: boolean | null,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "ok",
    usage,
    subscription_active: subscriptionActive,
  };
}

function okNoSubscription(): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "ok",
    no_subscription: true,
  };
}

function okSignedOut(): Record<string, unknown> {
  return { schema_version: SCHEMA_VERSION, status: "ok", signed_out: true };
}

function errorArm(
  errorType: string,
  message: string,
  screenExcerptLines: string[],
  errorKind: string,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    status: "error",
    error_kind: errorKind,
    error_type: errorType,
    message,
    screen_excerpt: screenExcerptLines,
  };
}

// ---------- helpers ---------------------------------------------------------

/**
 * Compact nonblank rendered screen lines for diagnosing parse failures: head +
 * tail with an elided middle so a huge panel can't balloon the JSON. Each line
 * is rstripped and clamped to 240 chars.
 */
export function screenExcerpt(rendered: string, maxLines = 24): string[] {
  const lines = rendered
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/\s+$/, "").slice(0, 240));
  if (lines.length <= maxLines) {
    return lines;
  }
  const head = Math.floor(maxLines / 2);
  const tail = maxLines - head - 1;
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `... ${omitted} lines omitted ...`,
    ...lines.slice(lines.length - tail),
  ];
}

/**
 * Translate --profile into scrape()'s passthrough args. A named claude profile
 * routes through the agent-profile shim; the default account is native
 * ~/.claude and codex has no profile concept.
 */
export function passthroughFor(target: Target, profile: string): string[] {
  if (target === "claude" && profile !== "default") {
    return ["--agent-profile", profile];
  }
  return [];
}

function defaultClaudeCommand(): string {
  return TARGETS.claude.command;
}

/**
 * True when the target's usage/status panel demonstrably rendered: claude's tab
 * strip header (case-insensitive, matching the parser's relaxed gate) or codex's
 * `5h limit:` row. A parser failure WITH evidence is real format drift; WITHOUT
 * it the panel never rendered.
 */
export function hasPanelEvidence(target: Target, rendered: string): boolean {
  if (target === "claude") {
    return rendered.toLowerCase().includes(PANEL_HEADER.toLowerCase());
  }
  return rendered.includes(PANEL_SENTINEL);
}

/**
 * Map a parser error + the rendered screen to a stable error_kind. An endpoint
 * rate-limit wins over panel evidence; a failure with panel evidence is
 * format_changed; one without is panel_missing.
 */
export function classifyParseError(
  target: Target,
  err: unknown,
  rendered: string,
): string {
  if (err instanceof ClaudeUsageEndpointRateLimited) {
    return ERROR_KIND_UPSTREAM_LIMITED;
  }
  if (hasPanelEvidence(target, rendered)) {
    return ERROR_KIND_FORMAT_CHANGED;
  }
  return ERROR_KIND_PANEL_MISSING;
}

/**
 * Runs `<cmd> auth status` and hands back its stdout. Injectable so the auth
 * classifier is testable without spawning claude; the default spawns the real
 * probe with a hard 15s timeout, draining stdout and stderr concurrently to
 * dodge a backpressure deadlock on a chatty child (Bun docs).
 */
export type AuthProbe = (
  argv: string[],
  env: Record<string, string>,
) => Promise<{ stdout: string }>;

const spawnAuthProbe: AuthProbe = async (argv, env) => {
  const proc = Bun.spawn(argv, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout: out };
};

/**
 * Claude auth status for a profile, or null when inconclusive. Best-effort
 * classifier for no-bar /usage screens: a definitive logged-out result becomes
 * the signed_out success arm; any failed probe leaves the no_subscription
 * classification intact. The default account is native ~/.claude (no
 * CLAUDE_CONFIG_DIR); named accounts live under ~/.claude-profiles/<profile>.
 */
export async function claudeAuthLoggedIn(
  profile: string,
  command: string | null,
  probe: AuthProbe = spawnAuthProbe,
): Promise<boolean | null> {
  const cmd = command ?? defaultClaudeCommand();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  if (profile === "default") {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude-profiles", profile);
  }
  if (isAbsolute(cmd)) {
    env.PATH = `${dirname(cmd)}${delimiter}${env.PATH ?? ""}`;
  }

  let stdout: string;
  try {
    ({ stdout } = await probe([cmd, "auth", "status"], env));
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (
    payload !== null &&
    typeof payload === "object" &&
    "loggedIn" in payload
  ) {
    const loggedIn = (payload as Record<string, unknown>).loggedIn;
    return typeof loggedIn === "boolean" ? loggedIn : null;
  }
  return null;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Surface the diagnostic stack on stderr only — stdout stays the one JSON line. */
function reportError(err: unknown): void {
  const trace =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  process.stderr.write(`${trace}\n`);
}

/**
 * Print exactly one JSON object on stdout and drain before returning. The worker
 * reads stdout as a single JSON object; a buffered, unflushed stdout inside a
 * Bun Worker can read back empty (Bun#24690), so the awaited write is mandatory.
 */
async function emit(payload: Record<string, unknown>): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(payload)}\n`);
}

// ---------- core flow -------------------------------------------------------

/**
 * Injectable collaborators for {@link run}. Defaults are the real scrape driver,
 * the claude auth classifier, and the stdout {@link emit}. A test overrides them
 * to drive every arm in-process — capturing the emitted payload object rather
 * than reading a stdout pipe, which stays empty inside bun test (Bun#24690).
 */
export interface RunDeps {
  scrape: typeof scrape;
  claudeAuthLoggedIn: typeof claudeAuthLoggedIn;
  emit: typeof emit;
}

/** Scrape one account, emit one JSON object, resolve to the process exit code. */
export async function run(
  target: Target,
  profile: string,
  command: string | null,
  rows: number | null,
  cols: number | null,
  deps: RunDeps = { scrape, claudeAuthLoggedIn, emit },
): Promise<number> {
  const parser = PARSERS[target];
  const passthrough = passthroughFor(target, profile);
  const nowArg = process.env.AGENTUSAGE_NOW;

  // The scrape itself can fail before any screen renders (binary missing, PTY
  // error). Treat that as the error arm with an empty excerpt. A logged-out
  // profile is detected pre-send inside scrape() and is a SUCCESS read.
  let now: Temporal.ZonedDateTime | undefined;
  let rendered: string;
  try {
    now = buildNow(target, nowArg);
    rendered = await deps.scrape(target, passthrough, { command, rows, cols });
  } catch (err) {
    if (err instanceof SignedOut) {
      await deps.emit(okSignedOut());
      return 0;
    }
    reportError(err);
    await deps.emit(
      errorArm(errName(err), errMessage(err), [], ERROR_KIND_SCRAPE_FAILED),
    );
    return 1;
  }

  // NoActiveSubscription is a SUCCESS (panel rendered, account has no plan
  // limits); everything else is real parse failure / format drift.
  let usage: unknown;
  try {
    usage = parser(rendered, now);
  } catch (err) {
    if (err instanceof NoActiveSubscription) {
      if (
        target === "claude" &&
        (await deps.claudeAuthLoggedIn(profile, command)) === false
      ) {
        await deps.emit(okSignedOut());
      } else {
        await deps.emit(okNoSubscription());
      }
      return 0;
    }
    reportError(err);
    const errorKind = classifyParseError(target, err, rendered);
    await deps.emit(
      errorArm(
        errName(err),
        errMessage(err),
        screenExcerpt(rendered),
        errorKind,
      ),
    );
    return 1;
  }

  // Codex has no subscription concept (null); a subscribed claude scrape is
  // always subscription_active=true (the no-sub case raised above).
  const subscriptionActive: boolean | null = target === "claude" ? true : null;
  await deps.emit(okSubscribed(usage, subscriptionActive));
  return 0;
}

// ---------- argv ------------------------------------------------------------

interface ParsedArgs {
  target: Target;
  profile: string;
  command: string | null;
  rows: number | null;
  cols: number | null;
}

/** Strict base-10 integer (rejects `4.0`). */
function parseIntArg(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

function parseArgv(argv: string[]): ParsedArgs | { error: string } {
  let target: string | undefined;
  let profile: string | undefined;
  let command: string | null = null;
  let rows: number | null = null;
  let cols: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      target = argv[++i];
    } else if (arg === "--profile") {
      profile = argv[++i];
    } else if (arg === "--command") {
      command = argv[++i] ?? null;
    } else if (arg === "--rows") {
      rows = parseIntArg(argv[++i]);
      if (rows === null) {
        return { error: "--rows must be an integer" };
      }
    } else if (arg === "--cols") {
      cols = parseIntArg(argv[++i]);
      if (cols === null) {
        return { error: "--cols must be an integer" };
      }
    } else {
      return { error: `unrecognized argument: ${arg}` };
    }
  }

  if (target === undefined) {
    return { error: "--target is required" };
  }
  if (target !== "claude" && target !== "codex") {
    return { error: "--target must be 'claude' or 'codex'" };
  }
  if (profile === undefined) {
    return { error: "--profile is required" };
  }
  return { target, profile, command, rows, cols };
}

export async function main(
  argv: string[],
  runFn: typeof run = run,
): Promise<number> {
  const parsed = parseArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  return runFn(
    parsed.target,
    parsed.profile,
    parsed.command,
    parsed.rows,
    parsed.cols,
  );
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
