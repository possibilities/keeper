/**
 * SLOW proof of the keeper→`uv`→agentusage-util→JSON round-trip (fn-930 `.3`
 * KEYSTONE). Unlike the fast unit test, this ACTUALLY invokes the `.1` util via a
 * real `uv` subprocess. It de-risks the three things that could sink the design:
 *
 *  1. `uv run --directory <agentusage>` resolves agentusage's project env and the
 *     `agentusage.scrape_cli` module under the real runtime.
 *  2. The seam's `Promise.all`-concurrent drain returns NON-EMPTY stdout — both
 *     from MAIN and from INSIDE a Bun Worker (the bun#24690 empty-stdout hazard
 *     the `.4` worker runs head-on into).
 *  3. The discriminated `{schema_version, status, …}` contract round-trips
 *     through `parseScrapeStdout` into a real {@link ScrapeResult} arm.
 *
 * Hermetic: every invocation forces the util down its FAST error arm with
 * `--command /usr/bin/false` — no real claude/codex TUI spawns, so there is NO
 * PTY scrape, NO `~/.claude-profiles/*` trust mutation, and NO network. The
 * contract still round-trips (the error arm is a real contract object), which is
 * exactly what we need to prove.
 *
 * Fast-tier-ignored: it spawns a real external process (`uv`), so it is named
 * `*.slow.test.ts` and excluded from the fast `bun test` via package.json's
 * `--path-ignore-patterns` (it runs under `test:full`). It carries NO real-git
 * signature, so the no-real-git allowlist does not apply. It is SKIPPED when `uv`
 * or the agentusage project dir is not present on the host.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ScrapeResult, spawnScrape } from "../src/usage-scrape-runner";

// Resolve the host's `uv` + agentusage project dir. Both must exist for the proof
// to run; otherwise the suite skips (the seam itself is unit-covered).
const UV_PATH = (() => {
  for (const c of ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"]) {
    if (existsSync(c)) return c;
  }
  return null;
})();
const AGENTUSAGE_DIR = (() => {
  const c = join(homedir(), "code", "agentusage");
  return existsSync(join(c, "agentusage", "scrape_cli.py")) ? c : null;
})();

const RUNNABLE = UV_PATH !== null && AGENTUSAGE_DIR !== null;
const maybe = RUNNABLE ? describe : describe.skip;

// Narrow the nullable host probes once for the runnable block (the `maybe`
// gate already skips when either is null; this satisfies the non-null typing
// without a forbidden `!` assertion).
const uvPath = UV_PATH ?? "";
const projectDir = AGENTUSAGE_DIR ?? "";

maybe("keeper→uv→util→JSON round-trip (real uv)", () => {
  test("MAIN: non-empty stdout, contract parses to a real arm", async () => {
    const result = await spawnScrape(
      { target: "codex", profile: "default", command: "/usr/bin/false" },
      { uvPath, projectDir, timeoutMs: 60_000 },
    );
    // The `/usr/bin/false` command makes scrape() fail BEFORE any panel renders,
    // which the util maps to its `error` arm — a real, parsed contract object.
    // The point: NOT a `runner_failure` with reason `empty_stdout`/`non_json`,
    // which would mean the round-trip itself broke.
    expect(result.kind).not.toBe("runner_failure");
    if (result.kind === "runner_failure") {
      throw new Error(
        `round-trip broke: ${result.reason} — ${result.message}\n${result.stderr}`,
      );
    }
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(typeof result.error_type).toBe("string");
      expect(result.error_type.length).toBeGreaterThan(0);
    }
  }, 90_000);

  test("WORKER: stdout non-empty inside a Bun Worker (bun#24690)", async () => {
    const worker = new Worker(
      new URL("./fixtures/scrape-in-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    try {
      type WorkerReply = {
        ok: boolean;
        result?: ScrapeResult;
        error?: string;
      };
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("worker timed out")),
          85_000,
        );
        worker.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(ev.data as WorkerReply);
        };
        worker.onerror = (err) => {
          clearTimeout(timer);
          reject(new Error(`worker error: ${err.message}`));
        };
        worker.postMessage({ uvPath, projectDir });
      });
      expect(reply.ok).toBe(true);
      const result = reply.result;
      if (result === undefined) {
        throw new Error(
          `worker returned no result: ${reply.error ?? "unknown"}`,
        );
      }
      // Same assertion as MAIN: an empty/garbled in-Worker stdout would surface
      // as a `runner_failure` (empty_stdout / non_json), which this rejects.
      if (result.kind === "runner_failure") {
        throw new Error(
          `bun#24690 reproduced in-Worker: ${result.reason} — ${result.message}`,
        );
      }
      expect(result.kind).toBe("error");
    } finally {
      worker.terminate();
    }
  }, 90_000);
});
