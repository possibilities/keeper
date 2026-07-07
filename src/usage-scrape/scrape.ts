/**
 * Drive a TUI through a tmux pane, scrape a rendered screen, return its text.
 *
 * Public API:
 *   scrape(targetName, passthroughArgs, opts?) -> Promise<string>
 *
 * Targets:
 *   claude   spawn `claude`, navigate to /usage, scrape the panel
 *   codex    spawn `codex`,  navigate to /status, scrape the panel
 *
 * tmux owns the PTY, VT100 rendering, and child reaping in C: this module shells
 * out to a dedicated named server (`tmux -L agentusage-scrape`) and reads the
 * rendered screen with `capture-pane`. A sentinel state machine drives the
 * keystrokes and waits for the panel to settle; the socket name, timing
 * constants, keystroke shape, trust pre-marking, and cleanup are the
 * load-bearing surface.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { resolveTmuxBin } from "../agent/tmux-launch";
import {
  NO_SUB_SENTINEL,
  SignedOut,
  USAGE_ENDPOINT_RATE_LIMIT_SENTINEL,
} from "./parse-claude-usage";
import { SPARK_SENTINEL } from "./parse-codex-status";

const COLS = 300;
const ROWS = 200;

// Snapshot-idle cadence: a screen is "quiet" once N consecutive
// `capture-pane -pJ` snapshots taken this far apart are byte-identical. The
// QUIET_SECONDS window maps to N = round(quiet / interval) identical snaps
// (0.6s -> 3).
const SNAPSHOT_INTERVAL = 0.2;
const QUIET_SECONDS = 0.6;

// Every idle wait is deadline-bounded: a never-converging spinner never settles,
// so the deadline is load-bearing. It caps the max active-churn we tolerate
// before proceeding without quiet.
const IDLE_ACTIVE_GRACE = 8.0;

// Keep the full two-attempt sentinel budget inside keeper's 60s spawn timeout so
// a panel that never renders returns a structured parse error + screen excerpt
// instead of being SIGKILLed as runner_failure:timed_out.
const SENTINEL_TIMEOUT = 15.0;
const SLASH_RETRIES = 2;
const RETRY_IDLE_SECONDS = 2.0;
const NO_SENTINEL_IDLE_SECONDS = 4.0;
const OPTIONAL_SETTLE_SECONDS = 1.0;

// Best-effort wait for an optional follow-up row that paints after the primary
// appear sentinel (e.g. claude's conditional "Current week (Sonnet only)" bar,
// only present when Sonnet usage > 0%). Short enough that a Sonnet-absent
// account doesn't slow the scrape noticeably.
const OPTIONAL_FOLLOW_TIMEOUT = 2.5;

// Dedicated tmux server socket. Isolates every scrape's sessions from the
// human's default server and from keeper's own tmux server.
const TMUX_SOCKET = "agentusage-scrape";

// Pre-scrape sweep threshold: 3x keeper's 60s spawn budget. A live scrape always
// finishes and kill-sessions itself well under 60s, so only a true leak from a
// SIGKILLed scrape survives past 180s — a concurrent fresh sibling scrape is
// always younger and never swept.
const STALE_SESSION_SECONDS = 180;

// Minimum tmux with the surfaces the driver needs (`new-session -e`,
// `capture-pane -J`, `#{alternate_on}`). Parsed leniently: an unparseable banner
// (e.g. `next-3.8`) passes; only a clearly-older numeric version is rejected.
const MIN_TMUX_MAJOR = 3;
const MIN_TMUX_MINOR = 2;

// Resolve the tmux binary through the shared resolver so a stripped LaunchAgent
// PATH still finds it; memoized since every driver call shells the same binary.
let tmuxBinCache: string | null = null;
function tmuxBin(): string {
  tmuxBinCache ??= resolveTmuxBin(process.env);
  return tmuxBinCache;
}

/** Thrown when the tmux driver itself cannot run (binary missing/too old, spawn
 *  fault). The CLI maps any scrape throw to its `scrape_failed` arm. */
export class ScrapeDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeDriverError";
  }
}

// ---------- Target definitions ---------------------------------------------

// Each target says: which binary to spawn, which slash command to type, and
// (optionally) sentinels for "panel opened" and "panel finished loading".
// Sentinels are strings that must appear somewhere in the rendered screen.
interface Target {
  command: string;
  slash: string;
  extraArgs?: string[];
  readyWait?: number;
  appear?: string | null;
  appearOptional?: string;
  appearNoSub?: string;
  appearError?: string;
  appearSettle?: number;
  signedOutSentinels?: readonly string[];
  gone?: string | null;
}

export const TARGETS: Record<"claude" | "codex", Target> = {
  claude: {
    // Bare claude binary — we bypass the arthack-claude wrapper to avoid its
    // devctl-roots cwd prompt (which trips when spawning in /tmp) and its
    // plugin/auth setup overhead. Profile selection is handled here by setting
    // CLAUDE_CONFIG_DIR from --agent-profile <name>.
    command: "/Users/mike/.local/bin/claude",
    slash: "/usage",
    // Bare binary boots faster than the wrapper, so the quiet window can fire
    // while Ink is still mounting — keystrokes then land before the input box is
    // ready. Hold longer.
    readyWait: 4.0,
    // Primary appear sentinel: the all-models weekly bar — present on every
    // claude account, deterministic, fast. We also do a best-effort follow-up
    // wait for the conditional Sonnet bar so accounts with Sonnet usage > 0%
    // capture it before we snapshot.
    appear: "Current week (all models)",
    appearOptional: "Current week (Sonnet only)",
    // Short-circuit sentinel for no-subscription accounts: the panel opens to
    // the usage-contribution breakdown ("% of usage") with NO rate-limit bars.
    // Keyed on the SAME literal as parse-claude-usage's NO_SUB_SENTINEL (imported,
    // not re-declared) so the two detections cannot desync. When the primary
    // `appear` sentinel never matches AND this one does, we snapshot immediately
    // instead of burning the full retry budget.
    appearNoSub: NO_SUB_SENTINEL,
    // Terminal error rendered by some accounts instead of usage bars. Treat it as
    // "panel settled" so the parser can return a structured error promptly
    // instead of waiting for the full appear-sentinel timeout.
    appearError: USAGE_ENDPOINT_RATE_LIMIT_SENTINEL,
    // OAuth sign-in fingerprint for a logged-out profile. A 2-of-3 quorum over
    // the joined display (see detectSignedOut) classifies the account as
    // signed_out PRE-SEND, before /usage is typed into the OAuth "Paste code
    // here" field. No single needle suffices: "Welcome to Claude Code" can paint
    // off the auth screen, so it only counts toward the quorum alongside the
    // paste prompt or the authorize URL.
    signedOutSentinels: [
      "Paste code here",
      "/oauth/authorize",
      "Welcome to Claude Code",
    ],
    gone: null,
  },
  codex: {
    // Bare codex binary. We bypass arthack-codex but still need its
    // --dangerously-bypass-approvals-and-sandbox flag: without it, a fresh
    // sandbox cwd triggers a one-time approval prompt that our flow doesn't
    // dismiss, causing the child to exit early.
    //
    // The binary path is resolved at launch by resolveCodexCommand(): prefer the
    // newest nvm install (its sibling node is available), avoid stale pnpm shims
    // unless they are the only option, and fall back to PATH. A hardcoded
    // Homebrew path rots on machines that install Codex through npm/pnpm/nvm.
    command: "codex",
    extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    slash: "/status",
    // Codex's Ink TUI takes ~3-4s to mount and route keystrokes; earlier sends
    // get swallowed as placeholder-clearing keystrokes in the input field rather
    // than firing the slash command.
    readyWait: 5.0,
    // Wait for the LAST line of the panel ("Weekly limit:") rather than the first
    // ("5h limit:"). The panel paints top-down, and the label can appear before
    // the reset suffix finishes; settle briefly after the sentinel so the parser
    // sees the complete line.
    appear: "Weekly limit:",
    appearSettle: 1.0,
    // Optional second Codex-Spark quota bucket; if present, wait for its header
    // (SPARK_SENTINEL, imported from the parser) and one extra settle so both
    // spark rows finish rendering.
    appearOptional: SPARK_SENTINEL,
    gone: null,
  },
};

// ---------- Pure arg / path helpers ----------------------------------------

/**
 * Strip --agent-profile <name> (or --agent-profile=<name>) from args.
 * Returns [remainingArgs, profileNameOrNull]. Translates the daemon's
 * wrapper-shaped passthrough args into a bare-claude env var.
 */
export function extractClaudeProfile(
  args: string[],
): [string[], string | null] {
  const out: string[] = [];
  let profile: string | null = null;
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--agent-profile" && i + 1 < args.length) {
      profile = args[i + 1];
      i += 2;
    } else if (args[i].startsWith("--agent-profile=")) {
      profile = args[i].split("=").slice(1).join("=");
      i += 1;
    } else {
      out.push(args[i]);
      i += 1;
    }
  }
  return [out, profile];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Sort key for ~/.nvm/versions/node/vX.Y.Z/bin/codex candidates. */
function nodeVersionKey(versionDir: string): number[] {
  const version = versionDir.startsWith("v") ? versionDir.slice(1) : versionDir;
  return version.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? -1 : n;
  });
}

function compareVersionKeys(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

/**
 * Resolve a stable Codex CLI path for non-interactive scraper launches.
 *
 * LaunchAgents usually have a stripped PATH, while user shells may point at a
 * stale pnpm shim that opens Codex's self-update prompt instead of the TUI. The
 * scraper wants the newest real install it can find. AGENTUSAGE_CODEX_COMMAND
 * remains an explicit escape hatch; the CLI's `--command` override is handled
 * before this helper is called.
 */
export function resolveCodexCommand(opts?: {
  home?: string;
  env?: Record<string, string | undefined>;
  whichCodex?: string | null;
  isExecutable?: (path: string) => boolean;
}): string {
  const home = opts?.home ?? homedir();
  const env = opts?.env ?? process.env;
  const executable = opts?.isExecutable ?? isExecutable;

  const explicit = (env.AGENTUSAGE_CODEX_COMMAND ?? "").trim();
  if (explicit) {
    return explicit;
  }

  const candidates: string[] = [];

  const nvmRoot = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmRoot)) {
    const nvmCodex = readdirSync(nvmRoot)
      .map((ver) => ({
        path: join(nvmRoot, ver, "bin", "codex"),
        key: nodeVersionKey(ver),
      }))
      .sort((a, b) => compareVersionKeys(b.key, a.key));
    candidates.push(...nvmCodex.map((c) => c.path));
  }

  let found = opts?.whichCodex;
  if (found === undefined) {
    found = Bun.which("codex", { PATH: env.PATH });
  }
  if (found && !found.includes("/Library/pnpm/")) {
    candidates.push(found);
  }

  candidates.push(
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
  );

  if (found) {
    candidates.push(found);
  }
  candidates.push(join(home, "Library", "pnpm", "bin", "codex"));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (executable(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

// ---------- Trust pre-marking ----------------------------------------------

interface ClaudeJson {
  projects?: Record<
    string,
    { isTrusted?: boolean; hasTrustDialogAccepted?: boolean }
  >;
}

/**
 * Mark `dirPath` as a trusted project in the profile's .claude.json.
 *
 * Without this, claude shows a hidden trust dialog on first entry to a sandbox
 * dir that silently swallows slash-command keystrokes. The flags we set match
 * what claude writes once the user manually accepts the dialog (isTrusted +
 * hasTrustDialogAccepted on the parent-dir entry). Idempotent — safe to call
 * before every spawn.
 */
export function ensureClaudeDirTrusted(
  configDir: string,
  dirPath: string,
): void {
  const cj = join(configDir, ".claude.json");
  let raw: string;
  try {
    raw = readFileSync(cj, "utf8");
  } catch {
    return; // missing or unreadable — nothing to mark
  }
  let data: ClaudeJson;
  try {
    data = JSON.parse(raw) as ClaudeJson;
  } catch {
    return; // malformed — leave it untouched
  }
  data.projects ??= {};
  const projects = data.projects;
  const entry = projects[dirPath] ?? {};
  if (entry.isTrusted && entry.hasTrustDialogAccepted) {
    return;
  }
  entry.isTrusted = true;
  entry.hasTrustDialogAccepted = true;
  projects[dirPath] = entry;
  writeFileSync(cj, JSON.stringify(data, null, 2));
}

/**
 * Append a `[projects."<dirPath>"]` trusted entry to ~/.codex/config.toml.
 *
 * Codex's slash commands (e.g. /status) silently no-op in untrusted project
 * dirs. We append a TOML stanza if not already present — idempotent line-level
 * write (no stdlib TOML writer needed).
 */
export function ensureCodexDirTrusted(
  dirPath: string,
  home: string = homedir(),
): void {
  const cfg = join(home, ".codex", "config.toml");
  let text: string;
  try {
    text = readFileSync(cfg, "utf8");
  } catch {
    return;
  }
  const needle = `[projects."${dirPath}"]`;
  if (text.includes(needle)) {
    return;
  }
  writeFileSync(cfg, `${text}\n${needle}\ntrust_level = "trusted"\n`);
}

// ---------- tmux primitives -------------------------------------------------

interface TmuxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run one tmux command against the dedicated server and return its output.
 * Drains stdout and stderr concurrently — reading them serially risks a
 * backpressure deadlock on a chatty command (Bun docs).
 */
async function runTmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn([tmuxBin(), "-L", TMUX_SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Probe tmux up front. A missing/unlaunchable binary or a clearly-too-old
 * version throws ScrapeDriverError (the CLI's scrape_failed arm) rather than
 * crashing mid-drive. The version parse is lenient: only a parseable numeric
 * version below the floor rejects; an odd banner like `next-3.8` passes.
 */
async function ensureTmuxUsable(): Promise<void> {
  let versionOut: string;
  try {
    const proc = Bun.spawn([tmuxBin(), "-V"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const outPromise = new Response(proc.stdout).text();
    const errPromise = new Response(proc.stderr).text();
    const [out] = await Promise.all([outPromise, errPromise]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new ScrapeDriverError(`tmux -V exited ${code}`);
    }
    versionOut = out;
  } catch (err) {
    if (err instanceof ScrapeDriverError) {
      throw err;
    }
    throw new ScrapeDriverError(
      "tmux binary not found or not executable — the Bun scrape driver requires tmux >= 3.2",
    );
  }
  const m = /(\d+)\.(\d+)/.exec(versionOut);
  if (m) {
    const major = Number.parseInt(m[1], 10);
    const minor = Number.parseInt(m[2], 10);
    if (
      major < MIN_TMUX_MAJOR ||
      (major === MIN_TMUX_MAJOR && minor < MIN_TMUX_MINOR)
    ) {
      throw new ScrapeDriverError(
        `tmux ${major}.${minor} is too old — the Bun scrape driver requires tmux >= 3.2`,
      );
    }
  }
}

function rstripLine(line: string): string {
  return line.replace(/\s+$/, "");
}

/**
 * Capture the visible pane as newline-joined, per-row rstripped text — the shape
 * the parsers expect. `-p` prints the visible (alt-screen, when active) buffer;
 * `-J` rejoins terminal-wrapped rows so a sentinel split across a wrap still
 * lands on one line. Never `-a` (it errors when the pane is not on the alternate
 * screen). A dead/gone pane returns "".
 */
async function captureJoined(session: string): Promise<string> {
  const { stdout, exitCode } = await runTmux([
    "capture-pane",
    "-p",
    "-J",
    "-t",
    session,
  ]);
  if (exitCode !== 0) {
    return "";
  }
  return stdout.replace(/\n$/, "").split("\n").map(rstripLine).join("\n");
}

/** True once the pane's child has exited (`#{pane_dead}`) or the session is
 *  gone — the closed-output signal that the child's output has ended. */
async function paneDead(session: string): Promise<boolean> {
  const { stdout, exitCode } = await runTmux([
    "display-message",
    "-p",
    "-t",
    session,
    "#{pane_dead}",
  ]);
  return exitCode !== 0 || stdout.trim() === "1";
}

/** True when the pane is on the alternate screen (`#{alternate_on}`) — a
 *  full-screen Ink TUI switches into it on boot; a plain shell never does. */
async function alternateOn(session: string): Promise<boolean> {
  const { stdout, exitCode } = await runTmux([
    "display-message",
    "-p",
    "-t",
    session,
    "#{alternate_on}",
  ]);
  return exitCode === 0 && stdout.trim() === "1";
}

function nowSeconds(): number {
  return performance.now() / 1000;
}

function sleep(seconds: number): Promise<void> {
  return Bun.sleep(seconds * 1000);
}

/**
 * Wait until the rendered screen goes quiet: N consecutive byte-identical
 * `capture-pane -pJ` snapshots, where N = round(quietSeconds / interval) (min 3).
 * Deadline-bounded so a never-settling spinner proceeds after IDLE_ACTIVE_GRACE
 * of churn. Returns early if the pane's child exits (closed output).
 */
async function pumpUntilIdle(
  session: string,
  quietSeconds: number = QUIET_SECONDS,
): Promise<void> {
  const need = Math.max(3, Math.round(quietSeconds / SNAPSHOT_INTERVAL));
  const deadline = nowSeconds() + quietSeconds + IDLE_ACTIVE_GRACE;
  let prev: string | null = null;
  let stable = 0;
  while (nowSeconds() < deadline) {
    const snap = await captureJoined(session);
    if (await paneDead(session)) {
      return;
    }
    if (snap === prev) {
      stable += 1;
      if (stable >= need) {
        return;
      }
    } else {
      prev = snap;
      stable = 1;
    }
    await sleep(SNAPSHOT_INTERVAL);
  }
}

/** Poll until any of `needles` appears on screen, or the deadline. Returns the
 *  first matched needle, or null. */
async function pumpUntilAnyText(
  session: string,
  needles: Array<string | null | undefined>,
  maxSeconds: number = SENTINEL_TIMEOUT,
): Promise<string | null> {
  const active = needles.filter((n): n is string => Boolean(n));
  const deadline = nowSeconds() + maxSeconds;
  while (nowSeconds() < deadline) {
    const screen = await captureJoined(session);
    for (const needle of active) {
      if (screen.includes(needle)) {
        return needle;
      }
    }
    if (await paneDead(session)) {
      return null; // closed output; the frozen frame already failed the check above
    }
    await sleep(SNAPSHOT_INTERVAL);
  }
  const screen = await captureJoined(session);
  for (const needle of active) {
    if (screen.includes(needle)) {
      return needle;
    }
  }
  return null;
}

async function pumpUntilText(
  session: string,
  needle: string,
  maxSeconds: number = SENTINEL_TIMEOUT,
): Promise<boolean> {
  return (await pumpUntilAnyText(session, [needle], maxSeconds)) === needle;
}

/** Poll until `needle` is no longer on screen, or the deadline. */
async function pumpWhileText(
  session: string,
  needle: string,
  maxSeconds: number = SENTINEL_TIMEOUT,
): Promise<boolean> {
  const deadline = nowSeconds() + maxSeconds;
  while (nowSeconds() < deadline) {
    if (!(await captureJoined(session)).includes(needle)) {
      return true;
    }
    if (await paneDead(session)) {
      return false; // needle still present and the frame is frozen
    }
    await sleep(SNAPSHOT_INTERVAL);
  }
  return !(await captureJoined(session)).includes(needle);
}

/** Let the pane keep rendering for a fixed settle window, returning early if the
 *  child exits. tmux renders on its own, so there are no bytes to pump — the
 *  wait is the settle. */
async function pumpFor(session: string, maxSeconds: number): Promise<void> {
  const deadline = nowSeconds() + maxSeconds;
  while (nowSeconds() < deadline) {
    if (await paneDead(session)) {
      return;
    }
    await sleep(SNAPSHOT_INTERVAL);
  }
}

/**
 * tmux surfaces {@link detectSignedOut} reads the screen through. Injectable so
 * the quorum logic stays unit-testable without a live tmux server; the default
 * drives the real pane. `alternateOn` reports the alt-screen gate; `capturePane`
 * returns a `-J` joined capture and its exit code.
 */
export interface SignInProbe {
  alternateOn: (session: string) => Promise<boolean>;
  capturePane: (
    session: string,
  ) => Promise<{ stdout: string; exitCode: number }>;
}

const tmuxSignInProbe: SignInProbe = {
  alternateOn,
  capturePane: (session) =>
    runTmux(["capture-pane", "-p", "-J", "-t", session]).then(
      ({ stdout, exitCode }) => ({ stdout, exitCode }),
    ),
};

/**
 * True when the alt-screen shows the OAuth sign-in fingerprint: a `minHits`-of-N
 * sentinel quorum over the rendered display so one stray needle can't
 * false-positive and a wrap-split needle still counts. Gated on the alt-screen
 * being active so a sentinel in normal-buffer scrollback can't spoof a sign-in.
 * `-J` already rejoins wrapped rows, so the newline-joined corpus usually
 * suffices; the dewrapped corpus is a belt-and-suspenders for any residual wrap.
 */
export async function detectSignedOut(
  session: string,
  sentinels: readonly string[],
  minHits = 2,
  probe: SignInProbe = tmuxSignInProbe,
): Promise<boolean> {
  if (!(await probe.alternateOn(session))) {
    return false;
  }
  const { stdout, exitCode } = await probe.capturePane(session);
  if (exitCode !== 0) {
    return false;
  }
  const stripped = stdout.replace(/\n$/, "").split("\n").map(rstripLine);
  const newlineJoined = stripped.join("\n");
  const dewrapped = stripped.join("");
  let hits = 0;
  for (const s of sentinels) {
    if (newlineJoined.includes(s) || dewrapped.includes(s)) {
      hits += 1;
    }
  }
  return hits >= minHits;
}

/**
 * Type the slash command as three send-keys calls: clear any partially-typed
 * input (`C-u`), type the slash literally (`-l`, so tmux never interprets it as
 * key names), then submit (`Enter` -> CR). A quiet pump after each keystroke
 * lets Ink render before the next.
 */
async function sendSlashCommand(session: string, slash: string): Promise<void> {
  await runTmux(["send-keys", "-t", session, "C-u"]);
  await pumpUntilIdle(session);
  await runTmux(["send-keys", "-t", session, "-l", slash]);
  await pumpUntilIdle(session);
  await runTmux(["send-keys", "-t", session, "Enter"]);
}

// ---------- Session lifecycle ----------------------------------------------

function sanitizeSessionName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Reap leaked sessions on the shared server older than `maxAgeSeconds`. A live
 * scrape kill-sessions itself; only a SIGKILLed scrape leaves a session behind,
 * and the 180s default (3x keeper's 60s budget) guarantees a concurrent fresh
 * sibling scrape is never swept. No server / no sessions is a no-op.
 */
export async function sweepStaleSessions(
  maxAgeSeconds: number = STALE_SESSION_SECONDS,
): Promise<void> {
  const { stdout, exitCode } = await runTmux([
    "list-sessions",
    "-F",
    "#{session_name} #{session_created}",
  ]);
  if (exitCode !== 0) {
    return; // no server running / no sessions
  }
  const nowEpoch = Date.now() / 1000;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const sep = trimmed.lastIndexOf(" ");
    if (sep < 0) {
      continue;
    }
    const name = trimmed.slice(0, sep);
    const created = Number.parseInt(trimmed.slice(sep + 1), 10);
    if (Number.isNaN(created)) {
      continue;
    }
    if (nowEpoch - created > maxAgeSeconds) {
      await runTmux(["kill-session", "-t", name]);
    }
  }
}

// ---------- Core scrape flow ------------------------------------------------

export async function scrape(
  targetName: "claude" | "codex",
  passthroughArgs: string[],
  opts?: {
    command?: string | null;
    rows?: number | null;
    cols?: number | null;
  },
): Promise<string> {
  const target = TARGETS[targetName];
  const slash = target.slash;

  const spawnRows = opts?.rows ?? ROWS;
  const spawnCols = opts?.cols ?? COLS;

  // Pin geometry + identity so tmux renders a deterministic screen regardless of
  // the (often absent) controlling-TTY environment under keeperd. The Ink TUIs
  // read LINES/COLUMNS/TERM; mismatched dims reflow the panel and break the
  // parser regexes. TERM is delivered via a `-f` config (tmux ignores `-e TERM`,
  // forcing it from default-terminal); everything else rides `-e`.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  env.TERM = "xterm-256color";
  env.LINES = String(spawnRows);
  env.COLUMNS = String(spawnCols);

  const command = opts?.command ?? null;
  let spawnCommand = command ?? target.command;
  if (targetName === "codex" && command === null) {
    spawnCommand = resolveCodexCommand({ env });
  }

  // Node-backed shims commonly use `#!/usr/bin/env node`; prepend the chosen
  // binary's directory so a stripped LaunchAgent PATH can still find sibling
  // `node` when spawning an absolute nvm-managed `codex`.
  if (isAbsolute(spawnCommand)) {
    env.PATH = `${dirname(spawnCommand)}${delimiter}${env.PATH ?? ""}`;
  }

  let args = [...(target.extraArgs ?? []), ...passthroughArgs];
  let configDir: string | null = null;
  if (targetName === "claude") {
    const [remaining, profile] = extractClaudeProfile(args);
    args = remaining;
    if (profile) {
      configDir = join(homedir(), ".claude-profiles", profile);
      env.CLAUDE_CONFIG_DIR = configDir;
    }
  }

  // Fail fast on a missing/too-old tmux before creating any sandbox: the CLI
  // maps the throw to scrape_failed instead of a crash trace on stdout.
  await ensureTmuxUsable();

  // Spawn in a throwaway /tmp dir so the TUI doesn't auto-load whatever project
  // we happen to be running in (its CLAUDE.md, local tool state, etc.).
  const tmpdir = mkdtempSync("/tmp/agentusage-scrape-");
  try {
    // Resolve symlinks (macOS /tmp -> /private/tmp) since both tools canonicalize
    // cwd before looking up trust state.
    const tmpdirReal = realpathSync(tmpdir);

    // TERM is load-bearing and cannot ride `-e` (tmux forces pane TERM from
    // default-terminal), so generate a one-line config sourced at server start.
    const confPath = join(tmpdir, "agentusage-scrape.tmux.conf");
    writeFileSync(confPath, 'set -g default-terminal "xterm-256color"\n');

    // Pre-mark the sandbox as trusted so the TUI doesn't show a hidden trust
    // dialog that silently eats slash-command keys. Claude indexes trust on the
    // /private/tmp parent; codex indexes on the exact cwd.
    if (configDir !== null) {
      ensureClaudeDirTrusted(configDir, "/private/tmp");
    }
    if (targetName === "codex") {
      ensureCodexDirTrusted(tmpdirReal);
    }

    // Reap leaks from prior SIGKILLed scrapes before minting our own session.
    await sweepStaleSessions();

    const session = sanitizeSessionName(
      `${targetName}-${configDir ? "profile" : "default"}-${process.pid}-${Bun.nanoseconds()}`,
    );

    // Inject the computed environment per-session: on a shared persistent server
    // the process env only reaches the child via `-e`, and stale server-global
    // values (a previous scrape's CLAUDE_CONFIG_DIR, a different geometry, a test
    // harness's AGENTUSAGE_FAKE_CASE) would otherwise leak in. TERM is excluded
    // (delivered via `-f`).
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (k === "TERM") {
        continue;
      }
      envFlags.push("-e", `${k}=${v}`);
    }

    const created = await runTmux([
      "-f",
      confPath,
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      String(spawnCols),
      "-y",
      String(spawnRows),
      "-c",
      tmpdirReal,
      ...envFlags,
      spawnCommand,
      ...args,
    ]);
    if (created.exitCode !== 0) {
      throw new ScrapeDriverError(
        `tmux new-session failed (exit ${created.exitCode}): ${created.stderr.trim()}`,
      );
    }

    try {
      // Per-session options only (`-t`, never `-g` — a global write disturbs
      // concurrent scrapes on the shared server).
      await runTmux(["set-option", "-t", session, "status", "off"]);
      await runTmux(["set-option", "-t", session, "escape-time", "0"]);

      await pumpUntilIdle(session, target.readyWait ?? QUIET_SECONDS);

      // Pre-send sign-in gate: a logged-out profile renders the OAuth screen, not
      // a usage panel. Classify it BEFORE sendSlashCommand, which does C-u then
      // types the slash + Enter into whatever field has focus — on the sign-in
      // screen that field is the OAuth "Paste code here" input, so a post-send
      // check would already have poisoned it with a bogus auth code. Living
      // inside this try means a detector throw runs cleanup and propagates to the
      // caller's scrape_failed arm, never crashes.
      const signedOutSentinels = target.signedOutSentinels;
      if (
        signedOutSentinels &&
        (await detectSignedOut(session, signedOutSentinels))
      ) {
        throw new SignedOut(
          "claude OAuth sign-in screen detected pre-send — profile is logged out",
        );
      }

      if (target.appear) {
        const appear = target.appear;
        let appeared = false;
        let nosubShortCircuit = false;
        let terminalShortCircuit = false;
        const appearNoSub = target.appearNoSub;
        const appearError = target.appearError;
        for (let attempt = 0; attempt < SLASH_RETRIES; attempt++) {
          await sendSlashCommand(session, slash);
          const matched = await pumpUntilAnyText(session, [
            appear,
            appearNoSub,
            appearError,
          ]);
          if (matched === appear) {
            appeared = true;
            break;
          }
          // On no-sub accounts the bars never paint so the retry budget would
          // otherwise burn every cycle.
          if (appearNoSub && matched === appearNoSub) {
            nosubShortCircuit = true;
            break;
          }
          // Some accounts render a terminal /usage error instead of bars.
          // Snapshot immediately and let the parser emit the structured error.
          if (appearError && matched === appearError) {
            terminalShortCircuit = true;
            break;
          }
          if (attempt + 1 < SLASH_RETRIES) {
            await pumpUntilIdle(session, RETRY_IDLE_SECONDS);
          }
        }
        if (!appeared && !nosubShortCircuit && !terminalShortCircuit) {
          process.stderr.write(
            `warning: sentinel '${appear}' never appeared\n`,
          );
        }
        const appearSettle = target.appearSettle;
        if (appeared && typeof appearSettle === "number" && appearSettle > 0) {
          await pumpFor(session, appearSettle);
        }

        // Best-effort wait for a conditional follow-up row that paints after
        // `appear` (e.g. claude's "Current week (Sonnet only)" bar, present only
        // when Sonnet usage > 0%). Timing out here is expected and silent — it
        // just means the row isn't on this account's panel.
        const appearOptional = target.appearOptional;
        if (appeared && appearOptional) {
          const matched = await pumpUntilText(
            session,
            appearOptional,
            OPTIONAL_FOLLOW_TIMEOUT,
          );
          if (matched) {
            // The sentinel matched the row's label, but the bar and Resets lines
            // below it render a moment later. Bounded settle so they land before
            // we snapshot.
            await pumpFor(session, OPTIONAL_SETTLE_SECONDS);
          }
        }
      } else {
        await sendSlashCommand(session, slash);
      }

      if (target.gone) {
        if (!(await pumpWhileText(session, target.gone))) {
          process.stderr.write(
            `warning: sentinel '${target.gone}' never cleared\n`,
          );
        }
      }
      if (!target.appear && !target.gone) {
        // No sentinels known yet — fall back to a generous idle window.
        await pumpUntilIdle(session, NO_SENTINEL_IDLE_SECONDS);
      }

      return await captureJoined(session);
    } finally {
      // Best-effort cleanup: send-keys C-c twice (a raw-mode TUI ignores the
      // signal, so honor it explicitly), then kill-session. The next scrape's
      // sweep is the leak backstop if this is cut short.
      try {
        await runTmux(["send-keys", "-t", session, "C-c"]);
        await runTmux(["send-keys", "-t", session, "C-c"]);
      } catch {
        // ignore — the pane may already be gone
      }
      try {
        await runTmux(["kill-session", "-t", session]);
      } catch {
        // ignore — the session may already be gone
      }
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
}

// ---------- Debug entry -----------------------------------------------------

/**
 * Thin debug entry for developing the driver directly: `bun
 * src/usage-scrape/scrape.ts --target claude [--command X] [--rows N]
 * [--cols M] [passthrough...]`. Prints the rendered screen to stdout (exit 0),
 * or the SignedOut signal / driver error to stderr. Not the production surface —
 * scrape-cli owns argv parsing and the discriminated JSON contract.
 */
async function debugMain(argv: string[]): Promise<number> {
  let target: string | undefined;
  let command: string | undefined;
  let rows: number | undefined;
  let cols: number | undefined;
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") {
      target = argv[++i];
    } else if (a === "--command") {
      command = argv[++i];
    } else if (a === "--rows") {
      rows = Number.parseInt(argv[++i], 10);
    } else if (a === "--cols") {
      cols = Number.parseInt(argv[++i], 10);
    } else {
      passthrough.push(a);
    }
  }
  if (target !== "claude" && target !== "codex") {
    process.stderr.write("--target must be 'claude' or 'codex'\n");
    return 2;
  }
  try {
    const rendered = await scrape(target, passthrough, { command, rows, cols });
    process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    return 0;
  } catch (err) {
    if (err instanceof SignedOut) {
      process.stderr.write(`SignedOut: ${err.message}\n`);
      return 0;
    }
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`${msg}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await debugMain(Bun.argv.slice(2)));
}
