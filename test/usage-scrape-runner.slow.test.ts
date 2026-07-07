/**
 * Real internal-entry scrape round-trip — held OUT of the fast pure-in-process
 * tier (spawns a real subprocess + tmux). Gated on `KEEPER_RUN_SLOW`; run it with
 * `KEEPER_RUN_SLOW=1 bun test test/usage-scrape-runner.slow.test.ts`.
 *
 * Proves the seam returns a VALID contract through `parseScrapeStdout` from inside
 * a `node:worker_threads` Worker — the production context the usage-scraper worker
 * runs in, where Bun#24690 can read a piped stdout back empty. The scrape is
 * forced down its fast error arm with `--command /usr/bin/false` (no real
 * claude/codex TUI, no trust mutation), so a green run means the pipe drained
 * non-empty and `parseScrapeStdout` classified a real `error` arm — NOT a
 * `runner_failure`/`empty_stdout`.
 *
 * Skips (rather than fails) when the INTERNAL scrape-cli entry is absent. That
 * entry is first-class keeper source, so this gate stays green after the external
 * agentusage repo is archived — the source no longer needs the sibling checkout.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import {
  defaultScrapeCliPath,
  type ScrapeResult,
} from "../src/usage-scrape-runner";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

// The skip-gate keys on the INTERNAL entry `spawnScrape` defaults to.
const ENTRY_PRESENT = existsSync(defaultScrapeCliPath());

/** Drive one real scrape inside a Worker via the shared fixture entry. */
function scrapeInWorker(): Promise<ScrapeResult> {
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
    // Any payload triggers the scrape; the fixture defaults to the internal entry.
    worker.postMessage({});
  });
}

describe.skipIf(!SLOW_ENABLED || !ENTRY_PRESENT)(
  "usage-scrape-runner — real internal-entry scrape (KEEPER_RUN_SLOW)",
  () => {
    test("a real scrape returns a valid error contract from a Worker", async () => {
      const result = await scrapeInWorker();
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
