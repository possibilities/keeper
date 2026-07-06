/**
 * Real bun-leg scrape round-trip — held OUT of the fast pure-in-process tier
 * (spawns a real subprocess + tmux). Gated on `KEEPER_RUN_SLOW`; run it with
 * `KEEPER_RUN_SLOW=1 bun test test/usage-scrape-runner.slow.test.ts`.
 *
 * Proves the runtime=bun leg returns a VALID contract through `parseScrapeStdout`
 * from inside a `node:worker_threads` Worker — the production context the
 * usage-scraper worker runs in, where Bun#24690 can read a piped stdout back
 * empty. The scrape is forced down its fast error arm with
 * `--command /usr/bin/false` (no real claude/codex TUI, no trust mutation), so a
 * green run means the pipe drained non-empty and `parseScrapeStdout` classified a
 * real `error` arm — NOT a `runner_failure`/`empty_stdout`.
 *
 * Skips (rather than fails) when the agentusage bun entry is absent, so the file
 * is a no-op on a box without the sibling repo checked out.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { UsageScraperRuntime } from "../src/db";
import type { ScrapeResult } from "../src/usage-scrape-runner";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

const AGENTUSAGE_DIR =
  process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR ??
  join(homedir(), "code", "agentusage");
const ENTRY_PRESENT = existsSync(join(AGENTUSAGE_DIR, "src", "scrape-cli.ts"));

/** Drive one real bun scrape inside a Worker via the shared fixture entry. */
function scrapeInWorker(runtime: UsageScraperRuntime): Promise<ScrapeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fixtures/scrape-in-worker.ts", import.meta.url).href,
    );
    worker.on(
      "message",
      (msg: { ok: boolean; result?: ScrapeResult; error?: string }) => {
        void worker.terminate();
        if (msg.ok && msg.result) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error ?? "scrape worker reported no result"));
        }
      },
    );
    worker.on("error", (err) => {
      void worker.terminate();
      reject(err);
    });
    worker.postMessage(runtime);
  });
}

describe.skipIf(!SLOW_ENABLED || !ENTRY_PRESENT)(
  "usage-scrape-runner — real bun leg (KEEPER_RUN_SLOW)",
  () => {
    test("a real bun scrape returns a valid error contract from a Worker", async () => {
      const runtime: UsageScraperRuntime = {
        runtime: "bun",
        bunPath: process.execPath,
        projectDir: AGENTUSAGE_DIR,
      };
      const result = await scrapeInWorker(runtime);
      // The pipe drained non-empty and parseScrapeStdout classified a genuine
      // contract arm — the `--command /usr/bin/false` scrape can only render an
      // error, never a runner_failure/empty_stdout.
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected the error arm");
      expect(typeof result.error_type).toBe("string");
      expect(result.error_type.length).toBeGreaterThan(0);
    }, 90_000);
  },
);
