// Shared test harness — the single seam every bun:test file routes its CLI
// invocations and on-disk seeding through. It is the byte-faithful port of the
// conftest fixture spec (tests/conftest.py): the built-from-scratch subprocess
// env (:580-613), the seed_state on-disk layout (:854-937), the per-worker tmp
// HOME (:545), the git fixtures (:382-498), set_roots (:717), fixed_clock
// (:997), the payload extractors (:762/:1047), and the git assertion helpers
// (:1076-1145).
//
// Isolation discipline: each test gets its own tmp HOME + tmp project, built
// from scratch — never process.env.copy() — so no XDG path or credential from
// the developer's shell leaks into the binary. The conftest's "minimal explicit
// env" is reproduced verbatim. seedState writes through the SAME store/models
// serialization the binary reads (serializeStateJson + normalizeEpic/Task), so a
// seeded tree carries zero schema drift — harness.test.ts is the standing proof.

import { afterEach, beforeEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { main } from "../src/cli.ts";
import { resetSelfEmit } from "../src/emit.ts";
import { normalizeEpic, normalizeTask, SCHEMA_VERSION } from "../src/models.ts";
import { resolveDataDirOrDefault } from "../src/state_path.ts";
import {
  resetStdinProvider,
  type StdinProvider,
  setStdinProvider,
} from "../src/stdin.ts";
import { serializeStateJson } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Binary resolution — the default `bun test` runs runCli IN-PROCESS (it
// dispatches main(argv) directly, never spawning the binary), so the compiled
// artifact is NOT required for the default tier. Only the KEEPER_PLAN_RUN_PROCESS
// slow bucket spawns it, and resolveBin() is its lazy resolver: it hard-fails on
// a missing binary at the spawn site, not at module load, so the default tier
// neither needs nor builds the binary.
// ---------------------------------------------------------------------------

/** Resolve the compiled binary for a spawning (slow-bucket) caller.
 * KEEPER_PLAN_BIN overrides (the conftest engine-selection env), else the dist
 * artifact. Hard-fails if neither exists. Lazy — the default in-process tier
 * never calls this. */
export function resolveBin(): string {
  const override = process.env.KEEPER_PLAN_BIN;
  const candidate =
    override && override.length > 0
      ? override
      : join(import.meta.dir, "..", "dist", "keeper-plan-bun");
  if (!existsSync(candidate)) {
    throw new Error(
      `keeper-plan binary missing at ${candidate}; run \`bun run build\` before \`bun test\`` +
        (override ? " (KEEPER_PLAN_BIN override set)" : ""),
    );
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Per-call + global timeout floor. The slow-bucket spawn carries a per-call
// timeout; the global floor is the package.json test-script --timeout. The
// default in-process runCli has no spawn to time out — a runaway loop is caught
// by the package.json --timeout. A spawning CLI call that hangs must fail the
// test, never wedge the suite.
// ---------------------------------------------------------------------------

/** Per-spawn timeout (ms) for the slow process bucket. A single spawned CLI
 * invocation that exceeds this is killed and surfaces as a non-zero/empty result
 * the assertion catches. Kept well under the package.json global --timeout floor
 * so a hung spawn fails its own test. */
export const SPAWN_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Env builder — the byte-faithful port of conftest's _subprocess_env (:580-613):
// built from scratch, never environ.copy(); HOME + XDG_* under the tmp HOME,
// GIT_CONFIG_GLOBAL -> a written temp gitconfig, GIT_CONFIG_SYSTEM=/dev/null,
// PATH, KEEPER_PLAN_ACTOR, the forwarded CLAUDE_CODE_SESSION_ID/KEEPER_PLAN_NOW,
// then the per-call override layered last.
// ---------------------------------------------------------------------------

/** Write the empty-but-identity-bearing global gitconfig the conftest writes
 * (:563-570): a real file (not /dev/null — git writes the committer identity
 * into it), carrying test identity + gpgsign=false + hooksPath=/dev/null. */
function writeGitConfig(home: string): string {
  const path = join(home, "gitconfig");
  writeFileSync(
    path,
    "[user]\n\temail = test@example.com\n\tname = Test User\n" +
      "[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n",
    "utf-8",
  );
  return path;
}

/** Build the minimal explicit subprocess env for *home*, layering *override*
 * last. Mirrors conftest._subprocess_env: scratch-built, HOME + XDG_* +
 * GIT_CONFIG_GLOBAL/SYSTEM + PATH + KEEPER_PLAN_ACTOR, forwarding
 * CLAUDE_CODE_SESSION_ID + KEEPER_PLAN_NOW when set in the parent env. The
 * default session id is pre-set (mutating verbs fail closed without it). */
export function buildEnv(
  home: string,
  override?: Record<string, string>,
): Record<string, string> {
  const gitconfig = writeGitConfig(home);
  const base: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    PATH: process.env.PATH ?? "",
    KEEPER_PLAN_ACTOR: process.env.KEEPER_PLAN_ACTOR ?? "test@example.com",
    // Mutating verbs require a session id to build their commit envelope; the
    // conftest fixtures pre-set this fixed value, so default it here too.
    CLAUDE_CODE_SESSION_ID:
      process.env.CLAUDE_CODE_SESSION_ID ?? "test-session-fixture",
  };
  // Forward an explicit clock override from the parent env (fixedClock sets it
  // process-wide for the in-process default; here it rides the subprocess env).
  if (process.env.KEEPER_PLAN_NOW !== undefined) {
    base.KEEPER_PLAN_NOW = process.env.KEEPER_PLAN_NOW;
  }
  if (override) {
    Object.assign(base, override);
  }
  return base;
}

// ---------------------------------------------------------------------------
// runCli — IN-PROCESS dispatch of main(argv). The compiled binary is never
// spawned here: instead the harness sets process.env to buildEnv(...), chdirs to
// opts.cwd, installs the stdin-provider override (feeding opts.input), captures
// process.stdout/stderr.write into strings, and makes process.exit throw an
// ExitCode carrier — then restores every global in `finally`. A verb that exits
// mid-run unwinds cleanly via the thrown ExitCode so the harness still returns
// {code, stdout, stderr, output}. Eliminates the ~414 process spawns + the
// `bun run build` dependency. The slow process bucket (runCliProcess) keeps the
// spawn for the handful of tests that genuinely exercise the binary boundary.
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr merged — the conftest `output` surface (mix_stderr=True). */
  output: string;
}

export interface RunOptions {
  cwd: string;
  /** Per-call env override, layered over buildEnv's base. */
  env?: Record<string, string>;
  /** Text fed to the verb's stdin readers (default: empty / no stdin). */
  input?: string;
  /** HOME for the env build. Defaults to <cwd>/.home; withProject sets a real one. */
  home?: string;
  /** Per-call timeout override (ms) — honored only by the slow process bucket. */
  timeoutMs?: number;
}

/** Private carrier the patched process.exit throws so an exiting verb unwinds to
 * runCli's catch with its intended code rather than killing the test process. */
class ExitCode {
  constructor(readonly code: number) {}
}

/** Dispatch `main(args)` in-process under a fully captured + restored global
 * environment. Returns the decoded {code, stdout, stderr, output}. The default
 * HOME is <cwd>/.home; pass `home` (or use withProject) for a dedicated tmp
 * HOME. */
export function runCli(args: string[], opts: RunOptions): CliResult {
  const home = opts.home ?? join(opts.cwd, ".home");
  mkdirSync(home, { recursive: true });

  const priorEnv = process.env;
  const priorCwd = process.cwd();
  const priorStdoutWrite = process.stdout.write;
  const priorStderrWrite = process.stderr.write;
  const priorExit = process.exit;
  const priorStdoutTTY = process.stdout.isTTY;

  let stdout = "";
  let stderr = "";
  let code = 0;

  // The patched process.exit throws ExitCode; selfEmitted must start clean per
  // call or the prior verb's self-emit leaks into the dispatcher's trailer gate.
  resetSelfEmit();
  setStdinProvider(makeStdinProvider(opts.input));

  try {
    process.env = buildEnv(home, opts.env);
    process.chdir(opts.cwd);
    // The spawned binary ran with piped (non-TTY) stdio; pin isTTY false so the
    // format auto-upgrade-to-human branch never fires in-process either.
    setTTY(process.stdout, false);
    process.stdout.write = captureWrite((s) => {
      stdout += s;
    }) as typeof process.stdout.write;
    process.stderr.write = captureWrite((s) => {
      stderr += s;
    }) as typeof process.stderr.write;
    process.exit = ((c?: number): never => {
      throw new ExitCode(c ?? 0);
    }) as typeof process.exit;

    try {
      code = main(args);
    } catch (exc) {
      if (exc instanceof ExitCode) {
        code = exc.code;
      } else {
        // An uncaught throw out of main() is exactly the spawned binary's
        // uncaught-exception path: Bun prints the error to stderr and exits 1.
        // Mirror it (code 1, message on stderr) so the harness still returns a
        // result and the "fails closed" tests see a non-zero code rather than a
        // crashed test process.
        stderr += `${exc instanceof Error ? (exc.stack ?? exc.message) : String(exc)}\n`;
        code = 1;
      }
    }
  } finally {
    process.env = priorEnv;
    process.chdir(priorCwd);
    process.stdout.write = priorStdoutWrite;
    process.stderr.write = priorStderrWrite;
    process.exit = priorExit;
    setTTY(process.stdout, priorStdoutTTY);
    resetStdinProvider();
  }

  return { code, stdout, stderr, output: stdout + stderr };
}

/** Build the stdin provider feeding an in-process call: a defined `input` is
 * piped (non-TTY); an undefined `input` is empty + non-TTY (the spawned default
 * was `stdin: "ignore"`, an immediate EOF — empty bytes, never a keyboard). */
function makeStdinProvider(input: string | undefined): StdinProvider {
  const buf = Buffer.from(input ?? "", "utf-8");
  return {
    readText: () => buf.toString("utf-8"),
    readBytes: (cap: number) => buf.subarray(0, cap),
    isTTY: () => false,
  };
}

/** A process.std*.write replacement that decodes (string | Uint8Array) and
 * forwards to a sink, honoring the optional encoding/callback signatures so a
 * caller passing a completion callback still proceeds. Always reports success. */
function captureWrite(
  sink: (s: string) => void,
): (chunk: unknown, ...rest: unknown[]) => boolean {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    sink(typeof chunk === "string" ? chunk : decode(chunk as Uint8Array));
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    cb?.(null);
    return true;
  };
}

/** Set a stream's isTTY without tripping the readonly type — the in-process
 * faithful-to-spawn pin and its restore. */
function setTTY(stream: NodeJS.WriteStream, value: boolean | undefined): void {
  (stream as unknown as { isTTY: boolean | undefined }).isTTY = value;
}

/** Spawn the COMPILED binary once and return its decoded result — the slow
 * process bucket's runner (gated on KEEPER_PLAN_RUN_PROCESS). Built env, pipe
 * stdio, per-call timeout, explicit Uint8Array decode. Resolves the binary
 * lazily so the default in-process tier never needs `bun run build`. */
export function runCliProcess(args: string[], opts: RunOptions): CliResult {
  const home = opts.home ?? join(opts.cwd, ".home");
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawnSync([resolveBin(), ...args], {
    cwd: opts.cwd,
    env: buildEnv(home, opts.env),
    stdin:
      opts.input !== undefined ? Buffer.from(opts.input, "utf-8") : "ignore",
    timeout: opts.timeoutMs ?? SPAWN_TIMEOUT_MS,
  });
  const stdout = decode(proc.stdout);
  const stderr = decode(proc.stderr);
  return {
    code: proc.exitCode ?? -1,
    stdout,
    stderr,
    output: stdout + stderr,
  };
}

/** True when the slow process bucket is enabled (KEEPER_PLAN_RUN_PROCESS set to
 * a truthy value). Pass to `describe.skipIf(!PROCESS_ENABLED)` to gate the
 * compiled-binary / process-boundary tests. */
export const PROCESS_ENABLED: boolean = ((): boolean => {
  const v = process.env.KEEPER_PLAN_RUN_PROCESS;
  return v !== undefined && v !== "" && v !== "0";
})();

/** Decode a spawn stream (Uint8Array | Buffer | string) to a UTF-8 string —
 * explicit, never an implicit toString on a raw buffer. */
function decode(stream: Uint8Array | Buffer | string | null): string {
  if (stream == null) {
    return "";
  }
  if (typeof stream === "string") {
    return stream;
  }
  return Buffer.from(stream).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Payload extractors — the port of conftest._first_json_payload (:762) and
// parse_cli_output (:1047). Mutating verbs emit a compact single NDJSON line;
// read verbs emit pretty JSON + a trailing {"plan_invocation": ...} line.
// ---------------------------------------------------------------------------

/** First stdout line that parses as a JSON object, skipping the trailing
 * {"plan_invocation": ...} decorator. Mirrors _first_json_payload — use for
 * a compact single-line (mutating-verb) envelope. */
export function firstJsonPayload(output: string): Record<string, unknown> {
  for (const raw of output.trim().split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || line.startsWith('{"plan_invocation"')) {
      continue;
    }
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // not a JSON line — keep scanning
    }
  }
  throw new Error(`no JSON payload in CLI output:\n${output}`);
}

/** Parse the primary JSON payload, dropping the trailing invocation line and
 * any leading non-JSON noise, then joining the rest (handles multi-line pretty
 * JSON from read verbs). Mirrors parse_cli_output. */
export function parseCliOutput(output: string): Record<string, unknown> {
  const lines = output.trim().split("\n");
  const primary = lines.filter(
    (ln) => !ln.trim().startsWith('{"plan_invocation"'),
  );
  while (primary.length > 0 && !primary[0]?.trimStart().startsWith("{")) {
    primary.shift();
  }
  return JSON.parse(primary.join("\n")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// seedState — byte-faithful port of conftest.seed_state (:854-937). Builds a
// full .keeper/ tree on disk without git, CLI, or flock, routing every record
// through normalizeEpic/normalizeTask + serializeStateJson (the SAME seams the
// read path runs). The skeleton + meta.json + inner .gitignore match init.
// ---------------------------------------------------------------------------

/** The four-section task spec the seed helpers write, carrying *marker* in the
 * Description. Mirrors conftest._task_spec. */
export function taskSpec(marker = "seed"): string {
  return (
    `## Description\n${marker}\n\n## Acceptance\n- [ ] x\n\n` +
    "## Done summary\n\n## Evidence\n"
  );
}

export interface SeedStateOptions {
  epicId: string;
  title?: string;
  epicSpec?: string;
  nTasks?: number;
  epicSnippets?: string[];
  epicBundles?: string[];
  taskSnippets?: Record<number, string[]>;
  taskBundles?: Record<number, string[]>;
  /** 1-based ordinal -> list of 1-based ordinals it depends on. */
  taskDeps?: Record<number, number[]>;
  primaryRepo?: string | null;
}

/** Atomic JSON write mirroring atomic_write_json: serializeStateJson bytes,
 * mkdir -p, plain write (no git/touched-log — seed builder is git-free). */
function writeJson(path: string, data: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, serializeStateJson(data), "utf-8");
}

/** Build a full .keeper/ tree under *root*, byte-faithful to conftest.seed_state.
 * Returns [epicId, taskIds]. No git, no CLI, no flock — the caller supplies the
 * fn-N epic id directly. Every record round-trips through normalize* so a seeded
 * tree carries zero schema drift versus the binary's read path. */
export function seedState(
  root: string,
  opts: SeedStateOptions,
): [string, string[]] {
  const {
    epicId,
    title = "Seed epic",
    epicSpec = "## Overview\nseed overview\n",
    nTasks = 1,
    epicSnippets = [],
    epicBundles = [],
    taskSnippets = {},
    taskBundles = {},
    taskDeps = {},
    primaryRepo = null,
  } = opts;

  const dataDir = join(root, ".keeper");
  for (const subdir of ["epics", "specs", "tasks", "state"]) {
    mkdirSync(join(dataDir, subdir), { recursive: true });
  }
  writeJson(join(dataDir, "meta.json"), { schema_version: SCHEMA_VERSION });
  writeFileSync(join(dataDir, ".gitignore"), "state/\n", "utf-8");

  const now = nowStamp();

  const epicDef = normalizeEpic({
    id: epicId,
    title,
    status: "open",
    primary_repo: primaryRepo,
    snippets: [...epicSnippets],
    bundles: [...epicBundles],
    created_at: now,
    updated_at: now,
  });
  writeJson(join(dataDir, "epics", `${epicId}.json`), epicDef);
  writeFileSync(join(dataDir, "specs", `${epicId}.md`), epicSpec, "utf-8");

  const taskIds: string[] = [];
  for (let i = 1; i <= nTasks; i++) {
    const taskId = `${epicId}.${i}`;
    taskIds.push(taskId);
    const dependsOn = (taskDeps[i] ?? []).map((d) => `${epicId}.${d}`);
    const taskDef = normalizeTask({
      id: taskId,
      epic: epicId,
      title: `Task ${i}`,
      depends_on: dependsOn,
      tier: "medium",
      target_repo: primaryRepo,
      snippets: [...(taskSnippets[i] ?? [])],
      bundles: [...(taskBundles[i] ?? [])],
      created_at: now,
      updated_at: now,
    });
    writeJson(join(dataDir, "tasks", `${taskId}.json`), taskDef);
    writeFileSync(
      join(dataDir, "specs", `${taskId}.md`),
      taskSpec(`seed-${i}`),
      "utf-8",
    );
  }

  return [epicId, taskIds];
}

/** The KEEPER_PLAN_NOW-honoring clock the seed stamps use, mirroring
 * store.nowIso's %Y-%m-%dT%H:%M:%S.%fZ wire format. Honors the env override (so
 * fixedClock pins seeded stamps) exactly like the binary's nowIso. */
function nowStamp(): string {
  const override = process.env.KEEPER_PLAN_NOW;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}000Z`
  );
}

// ---------------------------------------------------------------------------
// setRoots — port of conftest.set_roots (:717): write the roots config under the
// tmp HOME the binary reads (<HOME>/.config/planctl/config.yaml). The binary
// runs in its own subprocess under that HOME, so the file IS the seam.
// ---------------------------------------------------------------------------

/** Point planctl roots discovery at *roots* by writing the config the binary
 * reads under *home*. Mirrors set_roots' conformance branch (the only branch
 * that applies: every harness call is a subprocess). */
export function setRoots(home: string, roots: string[]): void {
  const cfgDir = join(home, ".config", "planctl");
  mkdirSync(cfgDir, { recursive: true });
  const body = `roots:\n${roots.map((r) => `  - ${r}\n`).join("")}`;
  writeFileSync(join(cfgDir, "config.yaml"), body, "utf-8");
}

// ---------------------------------------------------------------------------
// fixedClock — port of conftest.fixed_clock (:997): pin KEEPER_PLAN_NOW to the
// frozen microsecond-precision UTC stamp. Set on process.env so it drives both
// nowStamp (seedState) and the subprocess env (buildEnv forwards
// KEEPER_PLAN_NOW).
// ---------------------------------------------------------------------------

/** The frozen clock value conftest.fixed_clock pins. */
export const FROZEN_CLOCK = "2026-06-06T00:00:00.000000Z";

/** Pin KEEPER_PLAN_NOW to FROZEN_CLOCK for the duration of a test, restoring the
 * prior value on teardown. Returns the frozen stamp. Registers its own
 * afterEach restore, so call it at module scope inside a describe block. */
export function fixedClock(): string {
  const prior = process.env.KEEPER_PLAN_NOW;
  beforeEach(() => {
    process.env.KEEPER_PLAN_NOW = FROZEN_CLOCK;
  });
  afterEach(() => {
    if (prior === undefined) {
      delete process.env.KEEPER_PLAN_NOW;
    } else {
      process.env.KEEPER_PLAN_NOW = prior;
    }
  });
  return FROZEN_CLOCK;
}

// ---------------------------------------------------------------------------
// Tmpdir / project / git-repo hook-getters — module-scope registration, a
// single composite beforeEach/afterEach per getter. Ports the conftest tmp_path
// / project / planctl_git_repo fixtures. Each returns a getter the test reads
// inside its body (the value is minted fresh per test).
// ---------------------------------------------------------------------------

/** Run git with a local identity in *cwd*, throwing on failure. The bun analogue
 * of the conftest git subprocess calls. */
function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if ((proc.exitCode ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${decode(proc.stderr)}`);
  }
  return decode(proc.stdout);
}

/** Real `git init` + local committer identity in *dir* (the real-init branch of
 * the conftest fixtures). gpgsign off, hooks disabled. */
export function gitInit(dir: string): void {
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  git(["config", "core.hooksPath", "/dev/null"], dir);
}

/** Make a fresh realpath'd tmpdir under the OS temp root. */
function freshTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Register a fresh tmpdir per test; returns a getter the test calls in its body.
 * Mirrors the conftest tmp_path fixture (function-scoped, cleaned on teardown). */
export function withTmpdir(prefix = "planctl-tmp-"): () => string {
  let dir: string | null = null;
  beforeEach(() => {
    dir = freshTmp(prefix);
  });
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = null;
  });
  return () => {
    if (!dir) {
      throw new Error("withTmpdir getter read outside a test");
    }
    return dir;
  };
}

/** Register a fresh tmpdir with a real git init per test. Getter -> the repo
 * path. Mirrors the git-bearing fixtures' real-init branch. */
export function withGitRepo(prefix = "planctl-git-"): () => string {
  const getDir = withTmpdir(prefix);
  beforeEach(() => {
    gitInit(getDir());
  });
  return getDir;
}

export interface ProjectHandle {
  /** The project root (a git repo with `planctl init` applied). */
  root: string;
  /** The dedicated tmp HOME for this project's binary invocations. */
  home: string;
}

/** Register a fresh git repo + `planctl init` project per test, each with its own
 * dedicated tmp HOME (the per-worker-HOME isolation conftest imposes, scoped to
 * one test). Getter -> {root, home}. Pass {root, env: {...}, home} straight into
 * runCli for a project-rooted invocation. Mirrors the conftest `project`
 * fixture's real-init branch + the dedicated-HOME isolation. */
export function withProject(prefix = "planctl-project-"): () => ProjectHandle {
  const getRepo = withGitRepo(prefix);
  let home: string | null = null;
  beforeEach(() => {
    home = freshTmp(`${prefix}home-`);
    const root = getRepo();
    const res = runCli(["init"], { cwd: root, home });
    if (res.code !== 0) {
      throw new Error(`planctl init failed in withProject:\n${res.output}`);
    }
  });
  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
    home = null;
  });
  return () => {
    if (!home) {
      throw new Error("withProject getter read outside a test");
    }
    return { root: getRepo(), home };
  };
}

// ---------------------------------------------------------------------------
// Git assertion helpers — port of conftest's _git_log_count / _git_head_sha /
// _git_head_message / _git_files_in_head (:1076-1145). Subprocess git reads.
// ---------------------------------------------------------------------------

/** Number of commits on the current branch (0 on a fresh repo with no HEAD). */
export function gitLogCount(repo: string): number {
  const proc = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
    cwd: repo,
  });
  if ((proc.exitCode ?? -1) !== 0) {
    return 0;
  }
  return Number.parseInt(decode(proc.stdout).trim(), 10);
}

/** Current HEAD short sha. */
export function gitHeadSha(repo: string): string {
  return git(["rev-parse", "--short", "HEAD"], repo).trim();
}

/** HEAD commit full message. */
export function gitHeadMessage(repo: string): string {
  return git(["log", "-1", "--format=%B"], repo).trim();
}

/** Repo-relative paths changed in the HEAD commit. Uses `git show` (not
 * `diff-tree`) so a root commit — which has no parent to diff against — still
 * reports its files; `planctl init` lands as a root commit in a fresh repo. */
export function gitFilesInHead(repo: string): string[] {
  return git(["show", "--name-only", "--format=", "HEAD"], repo)
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Slow-bucket gate — port of the KEEPER_PLAN_RUN_SLOW visibility contract. A
// slow test is skipped unless KEEPER_PLAN_RUN_SLOW is set; under CLAUDECODE
// per-test lines are quiet, so the slow set's visibility is asserted via the run
// summary skip counts, not per-line. test.skipIf is the gate.
// ---------------------------------------------------------------------------

/** True when the slow bucket is enabled (KEEPER_PLAN_RUN_SLOW set to a truthy
 * value). Pass to `test.skipIf(!SLOW_ENABLED)` to gate a slow test. */
export const SLOW_ENABLED: boolean = ((): boolean => {
  const v = process.env.KEEPER_PLAN_RUN_SLOW;
  return v !== undefined && v !== "" && v !== "0";
})();

// ---------------------------------------------------------------------------
// gitBaseline — turn a seedState tree into a clean committed git baseline.
// Port of the test_worker_verbs / test_restamp_verbs `_git_seed` helper: real
// `git init` + commit the `.keeper/` tree so any later dirty state is the
// verb-under-test's. Used by the ZERO-commit / exactly-one-commit assertions.
// ---------------------------------------------------------------------------

/** `git init` + commit the seeded `.keeper/` tree in *dir*, returning the repo
 * path. Identity/gpgsign/hooks come from gitInit. The single baseline commit
 * means a follow-up `git rev-list --count HEAD` delta isolates the verb's
 * commit. */
export function gitBaseline(dir: string): string {
  gitInit(dir);
  git(["add", ".keeper/"], dir);
  git(["commit", "-q", "-m", "chore: seed keeper tree"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// seedRuntime — write a task's runtime-state overlay file directly (no verb, no
// lock). Port of the `_write_runtime` helper: bytes match save_runtime
// (json.dumps indent=2 sort_keys + trailing newline == serializeStateJson).
// ---------------------------------------------------------------------------

/** Write `<root>/<data-dir>/state/tasks/<taskId>.state.json` from *state*, byte-
 * faithful to LocalFileStateStore.saveRuntime. Resolves the root's `.keeper/`
 * data dir so the seeded overlay lands where the board's read path resolves it.
 * Seeds a runtime overlay a read verb merges over the tracked def. */
export function seedRuntime(
  root: string,
  taskId: string,
  state: Record<string, unknown>,
): void {
  const dir = join(resolveDataDirOrDefault(root), "state", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${taskId}.state.json`),
    serializeStateJson(state),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// pathShim — drop an executable fake binary on PATH. Port of the conftest
// fake-binary pattern (test_gist's _make_fake_gh, test_generated_guard_hook):
// an executable temp script that records its argv and emits a controlled
// stdout/exit. Returns {binDir, env, argvPath} so the caller layers env into
// runCli and reads the recorded argv back.
// ---------------------------------------------------------------------------

export interface PathShim {
  /** Directory holding the shim, prepended to PATH. */
  binDir: string;
  /** Env fragment to spread into runCli: PATH with binDir first. */
  env: Record<string, string>;
  /** File the shim writes its argv to (one arg per line), or null until run. */
  argvPath: string;
}

/** Drop an executable *name* in a fresh dir under *root* that records its argv
 * to `<binDir>/<name>-argv` (one arg per line) then prints *stdout* and exits
 * *exitCode* (a non-zero exit also writes a stderr line). Mirrors
 * _make_fake_gh: a `#!/usr/bin/env bun` script so the shim runs without a
 * system python. Returns the handle to layer into runCli's env. */
export function pathShim(
  root: string,
  name: string,
  opts: { stdout?: string; exitCode?: number; captureDir?: string } = {},
): PathShim {
  const { stdout = "", exitCode = 0, captureDir } = opts;
  const binDir = join(root, `shim-${name}`);
  mkdirSync(binDir, { recursive: true });
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
  }
  const argvPath = join(binDir, `${name}-argv`);
  const capture = captureDir
    ? `import { copyFileSync } from "node:fs";\n` +
      `import { basename } from "node:path";\n` +
      `for (const a of process.argv.slice(2)) {\n` +
      `  if (a.endsWith(".md")) {\n` +
      `    try { copyFileSync(a, ${JSON.stringify(captureDir)} + "/" + basename(a)); } catch {}\n` +
      `  }\n` +
      `}\n`
    : "";
  const script =
    "#!/usr/bin/env bun\n" +
    `import { writeFileSync } from "node:fs";\n` +
    capture +
    `writeFileSync(${JSON.stringify(argvPath)}, process.argv.slice(2).join("\\n") + "\\n");\n` +
    `if (${exitCode} !== 0) {\n` +
    `  process.stderr.write("fake ${name}: simulated failure\\n");\n` +
    `  process.exit(${exitCode});\n` +
    `}\n` +
    `process.stdout.write(${JSON.stringify(stdout)} + "\\n");\n`;
  writeFileSync(join(binDir, name), script, "utf-8");
  chmodSync(join(binDir, name), 0o755);
  return {
    binDir,
    env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    argvPath,
  };
}

// ---------------------------------------------------------------------------
// scaffoldEpic — mint an epic + N tasks through the COMPILED binary's scaffold
// verb. Port of conftest.seed_epic / _scaffold_plan_yaml: builds the scaffold
// `--file` YAML and returns the allocated {epicId, taskIds}. Unlike seedState
// (CLI-free disk builder) this drives the real mint path, so the caller's dir
// must be a git repo with `planctl init` applied (use withProject).
// ---------------------------------------------------------------------------

/** Build the scaffold `--file` YAML for an epic + *nTasks* tasks. Each task
 * carries a `seed-<i>` Description marker and tier=medium; *taskDeps* maps a
 * 1-based ordinal to the 1-based ordinals it depends on. Mirrors
 * _scaffold_plan_yaml. */
export function scaffoldPlanYaml(opts: {
  title: string;
  nTasks: number;
  branch?: string;
  taskDeps?: Record<number, number[]>;
}): string {
  const { title, nTasks, branch, taskDeps = {} } = opts;
  const blocks: string[] = [];
  for (let i = 1; i <= nTasks; i++) {
    const specLines = taskSpec(`seed-${i}`)
      .split("\n")
      .map((ln) => `      ${ln}`)
      .join("\n");
    const deps = taskDeps[i];
    const depLine =
      deps && deps.length > 0 ? `    deps: [${deps.join(", ")}]\n` : "";
    blocks.push(
      `  - title: Task ${i}\n${depLine}    tier: medium\n    spec: |\n${specLines}`,
    );
  }
  const branchLine = branch ? `  branch: ${branch}\n` : "";
  return (
    `epic:\n  title: ${title}\n${branchLine}` +
    "  spec: |\n    ## Overview\n    seed overview\n" +
    `tasks:\n${blocks.join("\n")}\n`
  );
}

export interface ScaffoldResult {
  epicId: string;
  taskIds: string[];
}

/** Scaffold an epic + *nTasks* tasks via the binary in *project* (a withProject
 * handle: an inited git repo + its dedicated HOME). Returns the allocated
 * {epicId, taskIds}. Mirrors conftest.seed_epic — a single transactional mint,
 * no incremental create verbs. Throws on a non-zero scaffold exit. */
export function scaffoldEpic(
  project: ProjectHandle,
  opts: {
    title?: string;
    nTasks?: number;
    branch?: string;
    taskDeps?: Record<number, number[]>;
    env?: Record<string, string>;
  } = {},
): ScaffoldResult {
  const { title = "Seed epic", nTasks = 1, branch, taskDeps, env } = opts;
  const yaml = scaffoldPlanYaml({ title, nTasks, branch, taskDeps });
  const planPath = join(project.root, "_seed_plan.yaml");
  writeFileSync(planPath, yaml, "utf-8");
  const res = runCli(["scaffold", "--file", planPath], {
    cwd: project.root,
    home: project.home,
    env,
  });
  if (res.code !== 0) {
    throw new Error(`scaffold failed in scaffoldEpic:\n${res.output}`);
  }
  const payload = firstJsonPayload(res.output);
  return {
    epicId: payload.epic_id as string,
    taskIds: payload.task_ids as string[],
  };
}
