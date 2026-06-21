/**
 * Cross-contract test for the keeper plan → keeper fold, exercised in ONE repo.
 *
 * This is the payoff the fn-822 fold exists for: the PRODUCER (the in-process
 * `keeper plan` dispatcher, co-hosted as the `plugins/plan` subtree) and the
 * CONSUMER (keeper's plan-worker → `epics` projection) are now in the same repo,
 * so the shared `.keeper/` data contract is assertable in a single test. Unlike
 * the `integration.test.ts` plan-fold e2e — which hand-writes the `.keeper/*.json`
 * to model what the producer emits — this test drives the REAL producer:
 * `keeper plan init` + `keeper plan scaffold --file <yaml>` mint and auto-commit
 * a real epic, and we assert keeper folds that exact on-disk shape.
 *
 * Producer auto-commit is load-bearing for the fn-629 observation gate: every
 * mutating plan verb commits its `.keeper/` scope inline at `emit()`, so the
 * scaffolded epic lands in git HEAD with no manual commit — the gate passes it
 * through and the boot scan emits its snapshot.
 *
 * This file spawns the keeper CLI + boots the in-process daemon (the plan-worker
 * fold path), so it is fast-tier-ignored and gates only under `bun run
 * test:full`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

/** The keeper CLI entrypoint — `keeper plan <verb>` runs the plan dispatcher
 * in-process (no compiled-binary spawn; that binary was retired in fn-829). */
const KEEPER_CLI = join(import.meta.dir, "..", "cli", "keeper.ts");

import { withInProcessDaemon } from "./helpers/in-process-daemon";
import { retryUntil } from "./helpers/retry-until";

/** Per-test sandbox repo (realpathSync so macOS `/var`→`/private/var` matches). */
let repo: string;
/** Tmp dir holding the daemon's plan-root config YAML. */
let cfgDir: string;
let configPath: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-plan-contract-")));
  cfgDir = realpathSync(
    mkdtempSync(join(tmpdir(), "keeper-plan-contract-cfg-")),
  );
  configPath = join(cfgDir, "config.yaml");
  // Point the daemon's plan worker at the sandbox repo (the realpath'd path the
  // producer's auto-commit + the boot scan both resolve to), never the real
  // ~/code/~/src trees.
  writeFileSync(configPath, `roots:\n  - ${JSON.stringify(repo)}\n`);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
});

/** Run a git subcommand in `repo`; throw on non-zero exit. */
function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (!r.success) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

/** Run `keeper plan <args>` in `repo`; return the parsed JSON envelope. */
function plan(...args: string[]): Record<string, unknown> {
  const r = Bun.spawnSync([process.execPath, KEEPER_CLI, "plan", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  if (!r.success) {
    throw new Error(
      `keeper plan ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}\n${stdout}`,
    );
  }
  // The success envelope is the last non-empty stdout line (a trailing
  // plan_invocation rides the same object).
  const lastLine = stdout.trimEnd().split("\n").at(-1) ?? "";
  return JSON.parse(lastLine) as Record<string, unknown>;
}

/**
 * The minimal valid scaffold YAML: one epic, one task. The task spec block is
 * the producer-required `## Description` / `## Acceptance` / `## Done summary` /
 * `## Evidence` shape (scaffold rejects a malformed spec at mint time).
 */
function scaffoldYaml(title: string): string {
  return [
    "epic:",
    `  title: ${title}`,
    "  spec: |",
    "    ## Overview",
    "    A cross-contract fixture.",
    "tasks:",
    "  - title: First task",
    "    deps: []",
    "    tier: medium",
    "    spec: |",
    "      ## Description",
    "      Implement the thing.",
    "",
    "      ## Acceptance",
    "      - [ ] It works.",
    "",
    "      ## Done summary",
    "",
    "      ## Evidence",
    "",
  ].join("\n");
}

test("keeper plan scaffold writes a .keeper epic → keeper plan-worker folds it into the epics projection", async () => {
  // --- PRODUCER: drive the in-process keeper plan dispatcher. ---
  // A real git repo with one commit so the producer's auto-commit has a HEAD to
  // build on (and the keeper fn-629 gate has a HEAD to probe against).
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-q", "-m", "init");

  const initEnv = plan("init");
  expect(initEnv.success).toBe(true);

  writeFileSync(join(repo, "plan.yaml"), scaffoldYaml("cross contract"));
  const scaffoldEnv = plan("scaffold", "--file", "plan.yaml");
  expect(scaffoldEnv.success).toBe(true);
  const epicId = scaffoldEnv.epic_id as string;
  expect(epicId.startsWith("fn-")).toBe(true);

  // The producer auto-commits its `.keeper/` scope at emit(), so the scaffolded
  // epic is already in HEAD — the keeper observation gate passes it through
  // without any manual stage/commit here.

  // --- CONSUMER: keeper plan-worker folds the on-disk epic. ---
  // `wake` pumps the reducer on MAIN, `server` is unused by these direct reads
  // but kept for parity, `plan` does the boot scan + emits the snapshot.
  await withInProcessDaemon(
    async ({ dbPath }) => {
      const { db: reader } = openDb(dbPath, { readonly: true });
      try {
        // The synthetic EpicSnapshot lands first (producer → plan-worker →
        // main), then the reducer folds it into the `epics` projection. Poll
        // the projection directly — the plan-worker degrade still runs its boot
        // scan per root under `disableNativeWatcher`.
        const epic = await retryUntil(() => {
          const row = reader
            .query(
              "SELECT epic_id, epic_number, title, status FROM epics WHERE epic_id = ?",
            )
            .get(epicId) as {
            epic_id: string;
            epic_number: number | null;
            title: string | null;
            status: string | null;
          } | null;
          return row ?? null;
        }, 8000);
        if (!epic) {
          throw new Error(
            `epic ${epicId} never folded into the epics projection`,
          );
        }
        // The folded columns reflect the producer-written epic JSON: number from
        // the `fn-N-…` id, the scaffold title, and the producer's `open` status.
        expect(epic.epic_id).toBe(epicId);
        expect(epic.epic_number).toBe(1);
        expect(epic.title).toBe("cross contract");
        expect(epic.status).toBe("open");
      } finally {
        reader.close();
      }
    },
    { env: { KEEPER_CONFIG: configPath }, workers: ["wake", "server", "plan"] },
  );
});
