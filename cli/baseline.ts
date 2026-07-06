#!/usr/bin/env bun
/**
 * `keeper baseline [<sha>] [--repo <dir>] [--wait] [--timeout-ms <n>]` — the
 * worker-facing READ surface over the suite-baseline store (docs/adr/0005). A
 * worker consults it to attribute a test failure as pre-existing at its base
 * commit or self-inflicted, instead of the banned `git stash` + rerun.
 *
 * The verb speaks the task-1 contract in `src/baseline-store.ts` and NOTHING
 * else — no socket, no RPC. A bare read reads the leaf + scans the spool and
 * prints the {@link BaselineReadState} union (green / suite-red / infra-error /
 * timeout, plus miss / computing) as one clean JSON value; it NEVER mutates.
 * `--wait` turns the verb into trigger-and-await: it writes exactly one
 * size-bounded request into the spool (the CLI is the spool's SOLE writer),
 * then polls the leaf until a terminal envelope or its own caller-owned
 * deadline. On the deadline it prints the still-non-terminal read state and
 * exits non-zero — a worker can never mistake "gave up waiting" for a result.
 *
 * Exit codes:
 *   0  a terminal envelope (green / suite-red / infra-error / timeout) — red is
 *      an ANSWER, not an error, so suite-red still exits 0.
 *   1  a bare read with no terminal result yet (miss / computing).
 *   2  usage / arg fault, or an unresolvable sha/repo (distinct from the
 *      daemon's checkout infra-error).
 *   3  `--wait` gave up at its deadline with no terminal envelope.
 *
 * Daemon-free by design (it reads state files directly): a hit still serves
 * with no daemon running; `--wait` on a miss warns that computation needs the
 * daemon yet still polls to its deadline. Sha resolution is CLI-side
 * (`git rev-parse` in the target repo), so an unresolvable ref is a usage
 * error, never mistaken for the daemon's infra-error verdict.
 *
 * Every I/O boundary (git, clock, sleep, leaf/spool read, spool write) is an
 * injectable seam so the poll/exit/spool-compose logic is exercised in-process
 * with zero real daemon, sleep, or git — the retryUntil idiom.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BaselineReadState,
  type BaselineRequest,
  type BaselineResult,
  baselineKey,
  buildRequest,
  classifyRead,
  currentToolchain,
  isValidSha,
  leafPath,
  newRequestId,
  readLeaf,
  readRequest,
  requestPath,
  spoolDir,
  type ToolchainFingerprint,
  writeRequest,
} from "../src/baseline-store";
import { type GitRunner, gitExec } from "../src/commit-work/git-exec";

// ── exit codes ───────────────────────────────────────────────────────────────

/** A terminal envelope was served (green / suite-red / infra-error / timeout). */
export const EXIT_OK = 0;
/** A bare read had no terminal result yet (miss / computing). */
export const EXIT_NO_RESULT = 1;
/** Usage / arg fault, or an unresolvable sha/repo. */
export const EXIT_USAGE = 2;
/** `--wait` reached its own deadline with no terminal envelope. */
export const EXIT_DEADLINE = 3;

// ── defaults ─────────────────────────────────────────────────────────────────

/** Default `--wait` deadline: long enough for a cold full-suite compute. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Default gap between leaf polls under `--wait`. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export const HELP = `keeper baseline — read the suite-baseline result at a commit

Usage:
  keeper baseline [<sha>] [flags]

Consults the daemon-computed fast-gate suite result at a commit sha so a worker
can attribute a test failure as pre-existing at its base or self-inflicted. A
bare read prints the result envelope (or miss/computing) as one clean JSON value
and NEVER writes. Reads state files directly — a hit serves with no daemon up.

Arguments:
  <sha>                 A git ref/sha to key on (default: HEAD of the repo).
                        Resolved CLI-side via git rev-parse; an unresolvable ref
                        is a usage error (exit 2), not an infra-error verdict.

Flags:
  --repo <dir>          Repo to resolve against (default: cwd's git root)
  --wait                Trigger-and-await: write ONE spool request, then poll the
                        leaf until a terminal envelope or the deadline
  --timeout-ms <n>      --wait deadline in ms (default ${DEFAULT_TIMEOUT_MS})
  --poll-interval-ms <n>  --wait poll gap in ms (default ${DEFAULT_POLL_INTERVAL_MS})
  --help, -h            Show this help

Exit codes:
  0  terminal envelope (green / suite-red / infra-error / timeout) — red is an
     answer, not an error
  1  bare read with no terminal result yet (miss / computing)
  2  usage / arg fault, or an unresolvable sha/repo
  3  --wait gave up at its deadline with no terminal envelope

Env fidelity caveat: the baseline runs in the daemon's scratch worktree with a
frozen-lockfile install; a failure it does NOT reproduce can still be real in a
divergent local env. Treat a green baseline as "no PRE-EXISTING failure here",
not "your env is identical".

Examples:
  keeper baseline                       # HEAD of cwd's repo, read-only
  keeper baseline $(git rev-parse HEAD) --wait
`;

// ── arg parsing ──────────────────────────────────────────────────────────────

export interface ParsedArgs {
  /** Positional ref/sha, or `null` for HEAD. */
  sha: string | null;
  /** `--repo`, or `null` for the cwd's git root. */
  repo: string | null;
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}

interface ParseFailure {
  ok: false;
  /** The sentinel `__help__` requests the HELP block; else a usage message. */
  message: string;
}

interface ParseSuccess {
  ok: true;
  args: ParsedArgs;
}

/** Parse a required positive-integer ms flag value. `null` on a bad value. */
function parsePositiveIntMs(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseBaselineArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        repo: { type: "string" },
        wait: { type: "boolean" },
        "timeout-ms": { type: "string" },
        "poll-interval-ms": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (values.help === true) {
    return { ok: false, message: "__help__" };
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      message: `expected at most one sha (got ${positionals.length})`,
    };
  }

  const sha = positionals[0] ?? null;
  const repo = typeof values.repo === "string" ? values.repo : null;

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof values["timeout-ms"] === "string") {
    const parsed = parsePositiveIntMs(values["timeout-ms"]);
    if (parsed === null) {
      return {
        ok: false,
        message: `invalid --timeout-ms '${values["timeout-ms"]}' (expected a positive integer)`,
      };
    }
    timeoutMs = parsed;
  }

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (typeof values["poll-interval-ms"] === "string") {
    const parsed = parsePositiveIntMs(values["poll-interval-ms"]);
    if (parsed === null) {
      return {
        ok: false,
        message: `invalid --poll-interval-ms '${values["poll-interval-ms"]}' (expected a positive integer)`,
      };
    }
    pollIntervalMs = parsed;
  }

  return {
    ok: true,
    args: { sha, repo, wait: values.wait === true, timeoutMs, pollIntervalMs },
  };
}

// ── target resolution (git-backed) ───────────────────────────────────────────

/** A resolved (canonical repo root, full commit sha) pair to key on. */
export interface ResolvedTarget {
  repoDir: string;
  sha: string;
}

interface ResolveFailure {
  ok: false;
  message: string;
}
interface ResolveSuccess {
  ok: true;
  target: ResolvedTarget;
}

/**
 * Resolve the repo's git toplevel and a full commit sha for the requested ref.
 * Keying on the canonical toplevel + full sha (never an abbreviated ref) keeps a
 * subdir read and a full-sha read landing on the SAME leaf the worker computes.
 * An unresolvable repo/ref is a usage failure — distinct from the daemon's
 * checkout infra-error verdict (a real repo whose sha can't be checked out).
 */
export async function resolveTarget(
  args: { sha: string | null; repo: string | null },
  git: GitRunner,
): Promise<ResolveFailure | ResolveSuccess> {
  const dir = args.repo ?? process.cwd();
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top.code !== 0) {
    return { ok: false, message: `not a git repository: ${dir}` };
  }
  const repoDir = top.stdout.trim();
  if (repoDir.length === 0) {
    return { ok: false, message: `could not resolve a git root under ${dir}` };
  }

  const ref = args.sha ?? "HEAD";
  const rev = await git(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: repoDir },
  );
  const sha = rev.stdout.trim();
  if (rev.code !== 0 || sha.length === 0) {
    return {
      ok: false,
      message: `cannot resolve '${ref}' to a commit in ${repoDir}`,
    };
  }
  if (!isValidSha(sha)) {
    return {
      ok: false,
      message: `resolved sha '${sha}' is not a valid git object id`,
    };
  }
  return { ok: true, target: { repoDir, sha } };
}

// ── read seam (leaf + spool scan) ────────────────────────────────────────────

/** The four terminal statuses a reader may treat as a computed answer. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "green",
  "suite-red",
  "infra-error",
  "timeout",
]);

/** True when the read state is a durable terminal result, not miss/computing. */
export function isTerminalResult(
  state: BaselineReadState,
): state is BaselineResult {
  return TERMINAL_STATUSES.has(state.status);
}

/**
 * Is a request for `key` currently spooled? Scans the spool maildir and matches
 * on the request's composed `key`. Fail-open: an unreadable/absent spool dir (no
 * daemon has ever run) reads as "no pending request", so the state folds to a
 * clean `miss` rather than throwing.
 */
export function hasPendingRequest(key: string, stateDir?: string): boolean {
  let names: string[];
  try {
    names = readdirSync(spoolDir(stateDir));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const req = readRequest(join(spoolDir(stateDir), name));
    if (req !== null && req.key === key) return true;
  }
  return false;
}

/** Read the leaf + scan the spool, folded into the reader's observed state. */
export function readBaselineState(
  key: string,
  stateDir?: string,
): BaselineReadState {
  const leaf = readLeaf(leafPath(key, stateDir));
  return classifyRead(leaf, hasPendingRequest(key, stateDir), key);
}

// ── runner (injectable) ──────────────────────────────────────────────────────

export interface RunDeps {
  /** Git runner (defaults to the real {@link gitExec}). */
  gitRunner?: GitRunner;
  /** Toolchain fingerprint half of the key (defaults to the live env). */
  toolchain?: ToolchainFingerprint;
  /** State-dir override forwarded to the default read/write seams. */
  stateDir?: string;
  /** Read seam (defaults to {@link readBaselineState} over the real fs). */
  readState?: (key: string) => BaselineReadState;
  /** Spool write seam (defaults to a fresh-id atomic write to the spool). */
  writeRequest?: (request: BaselineRequest) => void;
  /** Unix-ms clock (defaults to `Date.now`). */
  now?: () => number;
  /** Sleep seam (defaults to a real `setTimeout` promise). */
  sleep?: (ms: number) => Promise<void>;
  /** Stdout sink (defaults to `process.stdout`). */
  stdout?: (s: string) => void;
  /** Stderr sink (defaults to `process.stderr`). */
  stderr?: (s: string) => void;
}

/** What the runner returns to a test harness. Production reads only `exitCode`. */
export interface RunResult {
  exitCode: number;
  /** How many spool requests were written (0 or 1). */
  requestsWritten: number;
  /** The final observed read state (null only when target resolution failed). */
  final: BaselineReadState | null;
}

/** Render a read state as one pretty JSON value + trailing newline. */
function renderEnvelope(state: BaselineReadState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Run the read/await flow. A bare read prints the envelope and never mutates; a
 * terminal result exits 0, a miss/computing exits 1. `--wait` writes exactly one
 * spool request (UNLESS the result is already terminal — a hit needs no trigger),
 * then polls to the caller-owned deadline: a terminal envelope exits 0, and a
 * deadline with a still-non-terminal state prints that state and exits 3, so the
 * "gave up waiting" report can never be mistaken for a computed result.
 */
export async function runBaseline(
  args: ParsedArgs,
  deps: RunDeps = {},
): Promise<RunResult> {
  const git = deps.gitRunner ?? gitExec;
  const toolchain = deps.toolchain ?? currentToolchain();
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const readState =
    deps.readState ?? ((key) => readBaselineState(key, deps.stateDir));
  const write =
    deps.writeRequest ??
    ((request) =>
      writeRequest(requestPath(newRequestId(), deps.stateDir), request));

  const resolved = await resolveTarget({ sha: args.sha, repo: args.repo }, git);
  if (!resolved.ok) {
    stderr(`keeper baseline: ${resolved.message}\n`);
    return { exitCode: EXIT_USAGE, requestsWritten: 0, final: null };
  }
  const { repoDir, sha } = resolved.target;
  const key = baselineKey({ repoDir, sha, toolchain });

  // Bare read: print + classify exit. Never writes.
  if (!args.wait) {
    const state = readState(key);
    stdout(renderEnvelope(state));
    if (isTerminalResult(state)) {
      return { exitCode: EXIT_OK, requestsWritten: 0, final: state };
    }
    stderr(
      `keeper baseline: no computed result for ${sha} (status=${state.status}); pass --wait to trigger + block\n`,
    );
    return { exitCode: EXIT_NO_RESULT, requestsWritten: 0, final: state };
  }

  // --wait: a hit already on disk needs no trigger; anything else spools ONE
  // request, then polls the leaf to the caller-owned deadline.
  let state = readState(key);
  let requestsWritten = 0;
  if (!isTerminalResult(state)) {
    write(buildRequest({ repoDir, sha, toolchain }, now()));
    requestsWritten = 1;
    const deadlineAt = now() + args.timeoutMs;
    for (;;) {
      state = readState(key);
      if (isTerminalResult(state)) break;
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        stdout(renderEnvelope(state));
        stderr(
          `keeper baseline: deadline exceeded after ${args.timeoutMs}ms (status=${state.status}); no result computed\n`,
        );
        return { exitCode: EXIT_DEADLINE, requestsWritten, final: state };
      }
      await sleep(Math.min(args.pollIntervalMs, remaining));
    }
  }

  stdout(renderEnvelope(state));
  return { exitCode: EXIT_OK, requestsWritten, final: state };
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
  const parsed = parseBaselineArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      return;
    }
    process.stderr.write(`keeper baseline: ${parsed.message}\n\n${HELP}`);
    process.exit(EXIT_USAGE);
  }
  const result = await runBaseline(parsed.args);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.
// Direct invocation via `bun cli/baseline.ts` would bypass the dispatcher; run
// `bun cli/keeper.ts baseline <args>` instead.
