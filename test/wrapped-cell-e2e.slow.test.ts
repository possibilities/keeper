/**
 * Wrapped-cell end-to-end — the full pipe against a FIXTURE host provider matrix
 * (ADR 0010), held OUT of the fast pure-in-process tier because its final leg
 * spawns a real detached tmux pane. Gated on `KEEPER_RUN_SLOW`; run it with
 * `KEEPER_RUN_SLOW=1 bun test test/wrapped-cell-e2e.slow.test.ts`.
 *
 * The chain, against one sandboxed `KEEPER_CONFIG_DIR/matrix.yaml`:
 *   1. RENDER   — `render-plugin-templates` fans the matrix into per-cell `work`
 *                 plugins: wrapped `gpt-5.5-*` cells (worker runs the wrapper
 *                 driver) beside native `opus/sonnet-*` cells.
 *   2. RESOLVE  — the producer route seam (`resolveWorkerCell` + `defaultRouteProbe`)
 *                 classifies the roster: a served wrapped model routes, an unserved
 *                 one is no-route, a native model resolves its cell dir.
 *   3. PROVIDERS— `agent providers resolve` orders the candidates by pecking order,
 *                 and reordering the roster flips which harness serves first.
 *   4. RUN      — one real detached `keeper agent run <provider>` from a real git
 *                 worktree: the foreign harness's edit lands INSIDE that worktree
 *                 (the cwd-anchoring this design leans on) and the run captures a
 *                 `completed` envelope.
 *
 * The foreign harness is a deterministic STUB on the launch PATH — this suite pins
 * keeper's launch/anchor/envelope plumbing, never a real model call (mirroring the
 * repo's other slow-tier stubs, e.g. usage-scrape-runner's `/usr/bin/false`). So
 * the genuine external dependency the skip guards is `tmux` (the detached-pane
 * substrate): absent tmux, the run leg cannot execute and a green pass would be a
 * false negative — the gate skips LOUD instead.
 *
 * keeper runs from THIS worktree's source (`bun cli/keeper.ts`), never a
 * PATH-installed binary, so the suite exercises the checkout under test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { loadMatrix } from "../src/agent/matrix.ts";
import {
  composeWorkerCellDir,
  defaultRouteProbe,
  resolveWorkerCell,
} from "../src/worker-cell.ts";

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
 *  model `gpt-5.5` served by codex then pi (`order` = the cost pecking order). */
function matrixYaml(order: "codex-first" | "pi-first"): string {
  const codex = [
    "  - name: codex",
    "    models:",
    "      - gpt-5.5: gpt-5.5-codex",
  ];
  const pi = ["  - name: pi", "    models:", "      - gpt-5.5"];
  const wrapped =
    order === "codex-first" ? [...codex, ...pi] : [...pi, ...codex];
  return [
    "efforts:",
    "  - medium",
    "  - high",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - opus",
    "      - sonnet",
    ...wrapped,
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
      configDir = configDirWith(root, "config", matrixYaml("codex-first"));

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
        spawnSync("tmux", ["kill-server"], {
          env: { ...process.env, TMUX_TMPDIR: dir },
        });
        rmSync(dir, { recursive: true, force: true });
      }
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("render fans the roster into wrapped + native worker cells", () => {
      const workersDir = join(renderedPlan, "workers");
      const cells = readdirSync(workersDir).sort();
      // Native claude cells (opus/sonnet) AND the wrapped gpt-5.5 cells, one per
      // effort in the fixture roster.
      expect(cells).toEqual([
        "gpt-5.5-high",
        "gpt-5.5-medium",
        "opus-high",
        "opus-medium",
        "sonnet-high",
        "sonnet-medium",
      ]);

      // The wrapped cell's worker runs the WRAPPER DRIVER (sonnet/high) at the
      // wrapped turn cap, never the capability model itself.
      const wrapped = readFileSync(
        join(workersDir, "gpt-5.5-high", "agents", "worker.md"),
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

    test("the producer route seam classifies the fixture roster", () => {
      const load = () => loadMatrix(join(configDir, "matrix.yaml"));
      const probe = (model: string) => ({
        dirExists: () => true,
        probeShadow: () => null,
        probeRoute: () => defaultRouteProbe(model, load),
      });

      // A wrapped model the roster serves routes; one no provider serves is a
      // no-route; a native claude model routes.
      expect(defaultRouteProbe("gpt-5.5", load)).toEqual({ kind: "routed" });
      expect(defaultRouteProbe("nonesuch-9", load)).toEqual({
        kind: "no-route",
        model: "nonesuch-9",
      });
      expect(defaultRouteProbe("opus", load)).toEqual({ kind: "routed" });

      // resolveWorkerCell threads those verdicts. The embedded subagents matrix
      // stays claude-only by design (the host matrix is the sole overlay), so a
      // served wrapped model surfaces as a ROUTABLE out-of-matrix — distinct from
      // the no-route reject an unserved one gets.
      const gpt = resolveWorkerCell(
        composeWorkerCellDir("gpt-5.5", "high"),
        probe("gpt-5.5"),
      );
      expect(gpt).toMatchObject({ ok: false, kind: "out-of-matrix" });

      const unserved = resolveWorkerCell(
        composeWorkerCellDir("nonesuch-9", "high"),
        probe("nonesuch-9"),
      );
      expect(unserved).toEqual({
        ok: false,
        kind: "no-route",
        model: "nonesuch-9",
      });

      // A native model resolves cleanly to its own cell dir.
      const opus = resolveWorkerCell(
        composeWorkerCellDir("opus", "high"),
        probe("opus"),
      );
      expect(opus.ok).toBe(true);
      if (opus.ok) {
        expect(opus.pluginDir).toContain(join("workers", "opus-high"));
      }
    });

    test("providers resolve orders candidates by pecking order, and reordering flips it", () => {
      const codexFirst = runKeeper(
        ["agent", "providers", "resolve", "gpt-5.5", "high"],
        { KEEPER_CONFIG_DIR: configDir },
      );
      expect(codexFirst.status).toBe(0);
      const env1 = JSON.parse(codexFirst.stdout);
      expect(env1.driver).toBe("wrapped");
      expect(
        env1.candidates.map((c: { harness: string }) => c.harness),
      ).toEqual(["codex", "pi"]);

      // Reordering the roster changes which harness serves first — no rebuild,
      // no re-render, a one-line host edit.
      const flipped = configDirWith(
        root,
        "config-flip",
        matrixYaml("pi-first"),
      );
      const piFirst = runKeeper(
        ["agent", "providers", "resolve", "gpt-5.5", "high"],
        { KEEPER_CONFIG_DIR: flipped },
      );
      expect(piFirst.status).toBe(0);
      const env2 = JSON.parse(piFirst.stdout);
      expect(
        env2.candidates.map((c: { harness: string }) => c.harness),
      ).toEqual(["pi", "codex"]);
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
          "gpt-5.5",
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
