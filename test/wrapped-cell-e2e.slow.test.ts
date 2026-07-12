/**
 * Wrapped-cell end-to-end — the full pipe against a FIXTURE host provider matrix
 * (ADR 0010), held OUT of the fast pure-in-process tier because its final leg
 * spawns a real detached tmux pane. Gated on `KEEPER_RUN_SLOW`; run it with
 * `KEEPER_RUN_SLOW=1 bun test test/wrapped-cell-e2e.slow.test.ts`.
 *
 * The chain, against one sandboxed `KEEPER_CONFIG_DIR/matrix.yaml`:
 *   1. RENDER   — `render-plugin-templates` fans the matrix into per-cell `work`
 *                 plugins: the wrapped `gpt-5.3-codex-spark` cell (worker runs the
 *                 wrapper driver) beside native `opus/sonnet-*` cells.
 *   2. RESOLVE  — the producer worker-cell seam (`resolveWorkerCell` +
 *                 `composeWorkerCellDir`) composes each cell from the v2 host matrix
 *                 (ADR 0036): a wrapped model in subagent_models resolves its cell
 *                 dir like a native one; a model outside it is an out-of-matrix reject.
 *   3. PROVIDERS— `agent providers resolve` orders the candidates by pecking order;
 *                 the fixture serves the spark capability token via a SINGLE codex
 *                 provider, as a bare token (codex needs no alias — ADR 0010).
 *   4. RUN      — one real detached `keeper agent run <provider>` from a real git
 *                 worktree: the foreign harness's edit lands INSIDE that worktree
 *                 (the cwd-anchoring this design leans on) and the run captures a
 *                 `completed` envelope.
 *   5. CLOSE-OUT— the wrapper's OWN Phase 3/4: it re-runs its authoritative test
 *                 pass, soft-resets any foreign commit(s) back to the pre-launch
 *                 base, stages the git-derived change set by explicit path, and
 *                 lands exactly ONE commit carrying its OWN sanitized Task/Job-Id
 *                 trailers (stripping any forged trailer the provider tried to
 *                 smuggle into its declared `commit_message`).
 *
 * The foreign harness is a deterministic STUB on the launch PATH — this suite pins
 * keeper's launch/anchor/envelope plumbing, never a real model call (mirroring the
 * repo's other slow-tier stubs. So
 * the genuine external dependency the skip guards is `tmux` (the detached-pane
 * substrate): absent tmux, the run leg cannot execute and a green pass would be a
 * false negative — the gate skips LOUD instead.
 *
 * keeper runs from THIS worktree's source (`bun cli/keeper.ts`), never a
 * PATH-installed binary, so the suite exercises the checkout under test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MatrixV2 } from "../src/agent/matrix.ts";
import { composeWorkerCellDir, resolveWorkerCell } from "../src/worker-cell.ts";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;
/** The real detached-pane substrate. Its absence is the loud skip below. */
const TMUX_BIN = Bun.which("tmux");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEPER_CLI = join(REPO_ROOT, "cli", "keeper.ts");
/** The bun running this suite re-runs keeper from source. */
const BUN = process.execPath;

// LOUD skip: only when the slow tier was explicitly requested but the substrate
// is missing, so a green run is never mistaken for real coverage.
if (SLOW_ENABLED && TMUX_BIN === null) {
  console.warn(
    "[wrapped-cell-e2e] SKIPPED: tmux not found on PATH — the real detached " +
      "`keeper agent run` cannot launch, so this coverage is ABSENT. Install " +
      "tmux to exercise the wrapped-cell run leg.",
  );
}

/** A fixture roster: claude native (opus/sonnet), and the wrapped capability
 *  model `gpt-5.3-codex-spark` served by a single codex provider AS A BARE
 *  TOKEN — codex accepts bare model ids (ADR 0010), so activation needs no
 *  alias. The provider-qualified slashed alias-target form pi requires is
 *  unit/parity-proven on the axes task and needs no e2e duplication here. */
function matrixYaml(): string {
  return [
    "efforts:",
    "  - medium",
    "  - high",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - opus",
    "      - sonnet",
    "  - name: codex",
    "    models:",
    "      - gpt-5.3-codex-spark",
    "subagents:",
    "  - work",
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "defaults:",
    "  stop_timeout_ms: 3600000",
    "  max_attempts: 2",
    "",
  ].join("\n");
}

/** Write a config dir carrying just `matrix.yaml`. */
function configDirWith(root: string, name: string, yaml: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "matrix.yaml"), yaml);
  return dir;
}

/** Run keeper from THIS worktree's source. */
function runKeeper(
  args: string[],
  envPatch: Record<string, string>,
  cwd: string = REPO_ROOT,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BUN, [KEEPER_CLI, ...args], {
    cwd,
    env: { ...process.env, ...envPatch },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!SLOW_ENABLED || TMUX_BIN === null)(
  "wrapped-cell e2e — render → resolve → providers → detached run (KEEPER_RUN_SLOW)",
  () => {
    let root: string;
    let configDir: string;
    let renderedPlan: string;
    // Tracked so afterAll tears down the sandbox tmux server + short socket dir.
    const tmuxTmpDirs: string[] = [];

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "wrapped-e2e-"));
      configDir = configDirWith(root, "config", matrixYaml());

      // Render the plan plugin into a throwaway copy (its `.git` marks the
      // project root; the generated trees are stripped first), so the fixture
      // matrix — not the checkout's committed cells — drives the output.
      renderedPlan = join(root, "plan");
      cpSync(join(REPO_ROOT, "plugins", "plan"), renderedPlan, {
        recursive: true,
      });
      writeFileSync(join(renderedPlan, ".git"), "");
      for (const kind of ["commands", "skills", "agents", "workers"]) {
        rmSync(join(renderedPlan, kind), { recursive: true, force: true });
      }
      const r = runKeeper(
        ["prompt", "render-plugin-templates", "--project-root", renderedPlan],
        { KEEPER_CONFIG_DIR: configDir },
        renderedPlan,
      );
      if (r.status !== 0) {
        throw new Error(`render-plugin-templates failed: ${r.stderr}`);
      }
    });

    afterAll(() => {
      for (const dir of tmuxTmpDirs) {
        const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir };
        delete env.TMUX;
        delete env.TMUX_PANE;
        spawnSync("tmux", ["-L", "default", "kill-server"], { env });
        rmSync(dir, { recursive: true, force: true });
      }
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("render fans the roster into wrapped + native worker cells", () => {
      const workersDir = join(renderedPlan, "workers");
      const cells = readdirSync(workersDir).sort();
      // Native claude cells (opus/sonnet) AND the wrapped spark cell, one per
      // effort in the fixture roster.
      expect(cells).toEqual([
        "gpt-5.3-codex-spark-high",
        "gpt-5.3-codex-spark-medium",
        "opus-high",
        "opus-medium",
        "sonnet-high",
        "sonnet-medium",
      ]);

      // The wrapped cell's worker runs the WRAPPER DRIVER (sonnet/high) at the
      // wrapped turn cap, never the capability model itself.
      const wrapped = readFileSync(
        join(workersDir, "gpt-5.3-codex-spark-high", "agents", "worker.md"),
        "utf8",
      );
      expect(wrapped).toContain("model: sonnet");
      expect(wrapped).toContain("maxTurns: 160");

      // A native cell bakes its own model at the native turn cap — proving the
      // single template branches native vs wrapped, not a second template.
      const native = readFileSync(
        join(workersDir, "opus-high", "agents", "worker.md"),
        "utf8",
      );
      expect(native).toContain("model: opus");
      expect(native).toContain("maxTurns: 300");
    });

    test("the producer worker-cell seam composes each rendered cell from the v2 host matrix", () => {
      // The v2 host matrix IS the one cell axis (ADR 0036): subagent_models carries
      // native AND wrapped capabilities, so each composes its `workers/<model>-<effort>`
      // cell in the pure compose — no route probe, no re-derivation. The injected
      // matrix mirrors the fixture roster the render step fanned out.
      const load = (): MatrixV2 => ({
        efforts: ["medium", "high"],
        subagentTemplates: ["template/agents/worker.md.tmpl"],
        subagentModels: ["opus", "sonnet", "gpt-5.3-codex-spark"],
        providers: [],
        wrapper_driver: { model: "sonnet", effort: "high" },
        defaults: { stop_timeout_ms: 3600000, max_attempts: 2 },
        driverByModel: new Map(),
        effortsByModel: new Map(),
        shadowed: [],
        agentPins: new Map(),
      });
      const probe = { dirExists: () => true, probeShadow: () => null };

      // A wrapped capability in subagent_models resolves its rendered host cell dir
      // with the SAME manifest/shadow discipline a native cell runs.
      const spark = resolveWorkerCell(
        composeWorkerCellDir("gpt-5.3-codex-spark", "high", load),
        probe,
      );
      expect(spark.ok).toBe(true);
      if (spark.ok) {
        expect(spark.pluginDir).toContain(
          join("workers", "gpt-5.3-codex-spark-high"),
        );
      }

      // A native model resolves cleanly to its own cell dir.
      const opus = resolveWorkerCell(
        composeWorkerCellDir("opus", "high", load),
        probe,
      );
      expect(opus.ok).toBe(true);
      if (opus.ok) {
        expect(opus.pluginDir).toContain(join("workers", "opus-high"));
      }

      // A model outside subagent_models has no cell to compose → out-of-matrix.
      const unserved = resolveWorkerCell(
        composeWorkerCellDir("nonesuch-9", "high", load),
        probe,
      );
      expect(unserved).toMatchObject({ ok: false, kind: "out-of-matrix" });
    });

    test("providers resolve orders the codex candidate for the spark capability token", () => {
      const result = runKeeper(
        ["agent", "providers", "resolve", "gpt-5.3-codex-spark", "high"],
        { KEEPER_CONFIG_DIR: configDir },
      );
      expect(result.status).toBe(0);
      const env = JSON.parse(result.stdout);
      expect(env.driver).toBe("wrapped");
      // A bare capability token: codex needs no native-id alias to serve it.
      expect(env.candidates).toEqual([
        {
          harness: "codex",
          model_id: "gpt-5.3-codex-spark",
          preset_name: "codex-gpt-5.3-codex-spark",
        },
      ]);
    });

    test("a real detached wrapped run anchors the foreign edit in the worktree and captures a completed envelope", () => {
      const runRoot = mkdtempSync(join(tmpdir(), "wrapped-run-"));
      const home = join(runRoot, "home");
      mkdirSync(home, { recursive: true });
      const binDir = join(runRoot, "bin");
      mkdirSync(binDir, { recursive: true });
      const worktree = join(runRoot, "worktree");
      mkdirSync(worktree, { recursive: true });
      // A tmux socket path must stay under the ~104-char unix-socket limit, so the
      // server dir gets a short prefix (the deep per-test tmpdir would overflow).
      const tmuxTmp = mkdtempSync(join(tmpdir(), "kw-"));
      tmuxTmpDirs.push(tmuxTmp);

      // A real git working tree at the run cwd — the anchor target.
      const gitEnv = { ...process.env, HOME: home };
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "e2e@keeper.test"],
        ["config", "user.name", "e2e"],
        ["commit", "--allow-empty", "-qm", "base"],
      ]) {
        const g = spawnSync("git", args, { cwd: worktree, env: gitEnv });
        if (g.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${g.stderr}`);
        }
      }

      // The detached pane re-execs through `$SHELL -l -i`; on macOS path_helper
      // reorders PATH ahead of any inline prepend, so a sandbox HOME + a
      // bash_profile sourced AFTER it puts the stub dir first for the pane.
      writeFileSync(
        join(home, ".bash_profile"),
        `export PATH="${binDir}:$PATH"\n`,
      );

      // The STUB provider `pi` (bare-bin, PATH-resolved): it writes its edit into
      // its cwd (the anchoring probe) and a pi transcript keeper's wait→show reads
      // for a `completed` outcome. The pinned session id rides in on `--session-id`.
      const marker = "ANCHORED_BY_WRAPPED_RUN";
      const stub = [
        "#!/usr/bin/env bash",
        // keeper pushes the pinned id as a space-separated `--session-id <uuid>`
        // (main.ts), so a prev-token scan captures it.
        'sid=""; prev=""',
        'for a in "$@"; do',
        '  [ "$prev" = "--session-id" ] && sid="$a"',
        '  prev="$a"',
        "done",
        `printf '%s\\n' "${marker}" > "$(pwd)/anchored.txt"`,
        'if [ -n "$sid" ]; then',
        "  enc=\"--$(pwd | sed 's:^/::; s:/*$::; s:/:-:g')--\"",
        '  d="$HOME/.pi/agent/sessions/$enc"',
        '  mkdir -p "$d"',
        `  printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"endTurn","content":[{"type":"text","text":"${marker}"}]}}' > "$d/$sid.jsonl"`,
        "fi",
        "exit 0",
        "",
      ].join("\n");
      const stubPath = join(binDir, "pi");
      writeFileSync(stubPath, stub);
      chmodSync(stubPath, 0o755);

      const envJson = join(runRoot, "envelope.json");
      const runEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HOME: home,
        SHELL: "/bin/bash",
        KEEPER_CONFIG_DIR: configDir,
        TMUX_TMPDIR: tmuxTmp,
        PATH: `${binDir}:${process.env.PATH}`,
      };
      delete runEnv.TMUX; // never reuse an ambient server; create a fresh sandbox one

      // `keeper agent run` launches the detached pane AND blocks on wait→capture,
      // so the returned envelope spans the whole run. `--model/--effort` is the
      // both-explicit escape (no preset catalog needed).
      const r = spawnSync(
        BUN,
        [
          KEEPER_CLI,
          "agent",
          "run",
          "pi",
          "write the file",
          "--model",
          "gpt-5.3-codex-spark",
          "--effort",
          "high",
          "--output",
          envJson,
          "--stop-timeout",
          "30s",
        ],
        { cwd: worktree, env: runEnv, encoding: "utf8", timeout: 120_000 },
      );

      try {
        // The leg returned a terminal envelope (never hung out to the timeout).
        expect(r.status).toBe(0);
        const envelope = JSON.parse(readFileSync(envJson, "utf8"));
        expect(envelope.agent).toBe("pi");
        expect(envelope.outcome).toBe("completed");
        expect(envelope.message).toBe(marker);
        expect(envelope.transcript_path).toContain(join(home, ".pi", "agent"));

        // cwd-anchoring: the foreign edit landed INSIDE the run's worktree.
        const anchored = join(worktree, "anchored.txt");
        expect(existsSync(anchored)).toBe(true);
        expect(readFileSync(anchored, "utf8").trim()).toBe(marker);

        // …and shows up as that worktree's own diff, nowhere else.
        const status = spawnSync(
          "git",
          ["-C", worktree, "status", "--porcelain"],
          { encoding: "utf8" },
        );
        expect(status.stdout).toContain("anchored.txt");

        // Leg cleanup: the harness process exited (no orphan) — proven by the
        // pane no longer running the stub. Only the idle fallback shell remains,
        // reaped by kill-server in afterAll.
        const panes = spawnSync(
          "tmux",
          ["list-panes", "-a", "-F", "#{pane_current_command}"],
          { env: runEnv, encoding: "utf8" },
        );
        expect(panes.stdout).not.toContain("pi");
      } finally {
        rmSync(runRoot, { recursive: true, force: true });
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Close-out extension — the wrapped worker's back half (worker-implement-
// wrapped.md Phase 3/4), proven against a real detached leg and real git. Only
// the foreign CLI is faked (the same `pi` stub harness the run leg above
// proves the launch/anchor/envelope plumbing against); the re-test, the
// soft-reset, the explicit-path staging, and the commit all run for real.
//
// Residual observed while extending, NOT asserted here (lifecycle-owner
// territory, out of this task's scope): a wrapper that crashes mid-run leaves
// its detached leg orphaned rather than reaped — `keeper agent wait` polls a
// transcript path, not the wrapper's own liveness, so nothing here kills a leg
// whose wrapper died. The landed pidfile records the leg's pid for a LIVE
// wrapper to reap on resume; it carries no ownership signal once the wrapper
// itself is gone.
// ---------------------------------------------------------------------------

const FEATURE_MARKER = "SPARK_OK";
const FIXTURE_TASK_ID = "fn-0000-wrapped-e2e-fixture.1";
const FORGED_JOB_ID = "11111111-1111-1111-1111-111111111111";
const FORGED_SIGNOFF = "Evil Corp <evil@example.com>";

/** Mirrors `cli/commit-work.ts`'s `FORBIDDEN_TRAILER_RE` — the wrapper's own
 *  sanitize step, run on the provider's DECLARED `commit_message` before the
 *  wrapper appends its OWN `Task:`/`Job-Id:` trailers via the explicit-path
 *  escape hatch (the foreign edit is never session-attributed, so
 *  `keeper commit-work` cannot stage it). */
const FORBIDDEN_TRAILER_LINE_RE =
  /^(Job-Id:|Session-Id:|Signed-off-by:|Planctl-[A-Za-z]+:)/;

function sanitizeProviderMessage(msg: string): string {
  return msg
    .split("\n")
    .filter((line) => !FORBIDDEN_TRAILER_LINE_RE.test(line))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Run git for test setup/assertions; throws on a non-zero exit (a setup bug,
 *  never an expected-failure path in this suite). */
function gitCapture(args: string[], cwd: string, input?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

/** One close-out fixture case: the bash lines the STUB `pi` leg runs inside the
 *  worktree (the "foreign work" — an edit, plus zero/one/many contract-
 *  violating commits), and the wrapped-worker JSON envelope it returns as its
 *  final message — the contract's `{status, summary, files_changed, tests,
 *  commit_message}` shape, parsed and adjudicated by the wrapper exactly like a
 *  real leg's claim would be. */
interface CloseOutCase {
  name: string;
  foreignWork: string[];
  message: {
    status: string;
    summary: string;
    files_changed: string[];
    tests: string;
    commit_message: string;
  };
}

const CLOSE_OUT_CASES: CloseOutCase[] = [
  {
    name: "a clean leg (no foreign commit) lands as one sanitized wrapper commit",
    foreignWork: [`printf '${FEATURE_MARKER}\\n' > feature.txt`],
    message: {
      status: "completed",
      summary: "Implemented the bounded change.",
      files_changed: ["feature.txt"],
      tests: "passed",
      commit_message: "feat: add feature\n\nImplements the bounded change.",
    },
  },
  {
    name: "a single contract-violating foreign commit is soft-reset to one wrapper commit",
    foreignWork: [
      `printf '${FEATURE_MARKER}\\n' > feature.txt`,
      "git add feature.txt",
      'git commit -q -m "feat: sneaky provider commit"',
    ],
    message: {
      status: "completed",
      summary: "Implemented the bounded change.",
      files_changed: ["feature.txt"],
      tests: "passed",
      commit_message: "feat: add feature",
    },
  },
  {
    name: "multiple contract-violating foreign commits normalize to one wrapper commit",
    foreignWork: [
      `printf '${FEATURE_MARKER}\\n' > feature.txt`,
      "git add feature.txt",
      'git commit -q -m "feat: first sneaky commit"',
      `printf '${FEATURE_MARKER}\\nmore\\n' > feature.txt`,
      "git add feature.txt",
      'git commit -q -m "feat: second sneaky commit"',
    ],
    message: {
      status: "completed",
      summary: "Implemented the bounded change.",
      files_changed: ["feature.txt"],
      tests: "passed",
      commit_message: "feat: add feature",
    },
  },
  {
    name: "a forged trailer smuggled into the declared commit message is sanitized before landing",
    foreignWork: [`printf '${FEATURE_MARKER}\\n' > feature.txt`],
    message: {
      status: "completed",
      summary: "Implemented the bounded change.",
      files_changed: ["feature.txt"],
      tests: "passed",
      commit_message: `feat: add feature\n\nJob-Id: ${FORGED_JOB_ID}\nSigned-off-by: ${FORGED_SIGNOFF}`,
    },
  },
];

function runCloseOutCase(tc: CloseOutCase, tmuxTmpDirs: string[]): void {
  const runRoot = mkdtempSync(join(tmpdir(), "wrapped-close-"));
  const home = join(runRoot, "home");
  mkdirSync(home, { recursive: true });
  const binDir = join(runRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const worktree = join(runRoot, "worktree");
  mkdirSync(worktree, { recursive: true });
  const tmuxTmp = mkdtempSync(join(tmpdir(), "kw-"));
  tmuxTmpDirs.push(tmuxTmp);

  const gitEnv = { ...process.env, HOME: home };
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "e2e@keeper.test"],
    ["config", "user.name", "e2e"],
  ]) {
    const g = spawnSync("git", args, { cwd: worktree, env: gitEnv });
    if (g.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${g.stderr}`);
    }
  }
  // The wrapper's OWN re-test authority (Phase 3): a real, deterministic check
  // the close-out runs post-leg — never the provider's `tests` claim.
  writeFileSync(
    join(worktree, "check.sh"),
    `#!/usr/bin/env bash\nset -e\ngrep -q '${FEATURE_MARKER}' feature.txt\n`,
  );
  const addCheck = spawnSync("git", ["add", "check.sh"], {
    cwd: worktree,
    env: gitEnv,
  });
  if (addCheck.status !== 0) {
    throw new Error(`git add check.sh failed: ${addCheck.stderr}`);
  }
  const commitCheck = spawnSync("git", ["commit", "-q", "-m", "base"], {
    cwd: worktree,
    env: gitEnv,
  });
  if (commitCheck.status !== 0) {
    throw new Error(`git commit base failed: ${commitCheck.stderr}`);
  }
  const baseSha = gitCapture(["rev-parse", "HEAD"], worktree).trim();

  writeFileSync(join(home, ".bash_profile"), `export PATH="${binDir}:$PATH"\n`);

  // The leg's declared return value — attacker-influenced text in production,
  // here a fixed fixture — rides as the pi transcript's final assistant text.
  const messageJsonText = JSON.stringify(tc.message);
  const stub = [
    "#!/usr/bin/env bash",
    'sid=""; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "--session-id" ] && sid="$a"',
    '  prev="$a"',
    "done",
    ...tc.foreignWork,
    'if [ -n "$sid" ]; then',
    "  enc=\"--$(pwd | sed 's:^/::; s:/*$::; s:/:-:g')--\"",
    '  d="$HOME/.pi/agent/sessions/$enc"',
    '  mkdir -p "$d"',
    `  printf '%s\\n' '{"type":"message","message":{"role":"assistant","stopReason":"endTurn","content":[{"type":"text","text":${JSON.stringify(messageJsonText)}}]}}' > "$d/$sid.jsonl"`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const stubPath = join(binDir, "pi");
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);

  const envJson = join(runRoot, "envelope.json");
  const runEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    SHELL: "/bin/bash",
    TMUX_TMPDIR: tmuxTmp,
    PATH: `${binDir}:${process.env.PATH}`,
  };
  delete runEnv.TMUX;

  const r = spawnSync(
    BUN,
    [
      KEEPER_CLI,
      "agent",
      "run",
      "pi",
      "write the file",
      "--model",
      "gpt-5.3-codex-spark",
      "--effort",
      "high",
      "--output",
      envJson,
      "--stop-timeout",
      "30s",
    ],
    { cwd: worktree, env: runEnv, encoding: "utf8", timeout: 120_000 },
  );

  try {
    expect(r.status).toBe(0);
    const envelope = JSON.parse(readFileSync(envJson, "utf8"));
    expect(envelope.outcome).toBe("completed");
    const parsed = JSON.parse(
      envelope.message as string,
    ) as CloseOutCase["message"];

    // Phase 3 — adjudicate: the wrapper re-runs ITS OWN authoritative test
    // pass; the provider's `tests` field is a claim, never evidence.
    const check = spawnSync("bash", ["check.sh"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(check.status).toBe(0);

    // Phase 4 — normalize: soft-reset any foreign commit(s) back to the
    // pre-launch base (single or multi, byte-identical handling).
    const headAfterLeg = gitCapture(["rev-parse", "HEAD"], worktree).trim();
    if (headAfterLeg !== baseSha) {
      gitCapture(["reset", "--soft", baseSha], worktree);
    }

    // Stage the git-derived change set by explicit path — never `-A`/`.` —
    // reconciled BOTH directions against the provider's own `files_changed`.
    const tracked = gitCapture(["diff", "--name-only", baseSha], worktree)
      .split("\n")
      .filter(Boolean);
    const untracked = gitCapture(
      ["ls-files", "--others", "--exclude-standard"],
      worktree,
    )
      .split("\n")
      .filter(Boolean);
    const changed = Array.from(new Set([...tracked, ...untracked])).sort();
    expect(changed).toEqual([...parsed.files_changed].sort());
    gitCapture(["add", "--", ...changed], worktree);

    // Sanitize the provider's declared message through the forbidden-trailer
    // gate, then land ONE commit carrying the wrapper's OWN Task/Job-Id
    // trailers via `git interpret-trailers` (the escape-hatch commit path).
    const sanitized = sanitizeProviderMessage(parsed.commit_message);
    const jobId = randomUUID();
    const trailered = gitCapture(
      [
        "interpret-trailers",
        "--trailer",
        `Task=${FIXTURE_TASK_ID}`,
        "--trailer",
        `Job-Id=${jobId}`,
      ],
      worktree,
      sanitized,
    );
    gitCapture(["commit", "-F", "-"], worktree, trailered);

    // Exactly ONE wrapper commit lands beyond the pre-launch base, whether the
    // leg made zero, one, or two foreign commits.
    expect(
      gitCapture(["rev-list", `${baseSha}..HEAD`, "--count"], worktree).trim(),
    ).toBe("1");

    const finalMessage = gitCapture(["log", "-1", "--format=%B"], worktree);
    expect(finalMessage).toContain(`Task: ${FIXTURE_TASK_ID}`);
    expect(finalMessage).toContain(`Job-Id: ${jobId}`);
    // A forged trailer smuggled into the provider's declared message never
    // survives the sanitizer.
    expect(finalMessage).not.toContain(FORGED_JOB_ID);
    expect(finalMessage).not.toContain(FORGED_SIGNOFF);

    // Tree state matches the landed commit exactly — nothing left uncommitted.
    expect(gitCapture(["status", "--porcelain"], worktree).trim()).toBe("");
    expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toContain(
      FEATURE_MARKER,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

describe.skipIf(!SLOW_ENABLED || TMUX_BIN === null)(
  "wrapped-cell e2e — close-out: wrapper re-test, soft-reset, sanitized single commit (KEEPER_RUN_SLOW)",
  () => {
    const tmuxTmpDirs: string[] = [];

    afterAll(() => {
      for (const dir of tmuxTmpDirs) {
        const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir };
        delete env.TMUX;
        delete env.TMUX_PANE;
        spawnSync("tmux", ["-L", "default", "kill-server"], { env });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    for (const tc of CLOSE_OUT_CASES) {
      test(tc.name, () => runCloseOutCase(tc, tmuxTmpDirs));
    }
  },
);
