/**
 * Worker entry for the Bun#24690 proof in `test/usage-scrape-runner.slow.test.ts`.
 *
 * The hazard: a subprocess's stdout, drained INSIDE a Bun Worker, could read back
 * empty even when the child flushed (bun#24690). The usage-scraper worker runs
 * inside exactly such a Worker, so the seam's `Promise.all`-concurrent drain MUST
 * be proven to return non-empty stdout from this location, not just MAIN.
 *
 * This worker invokes the REAL scrape entry — the internal
 * `src/usage-scrape/scrape-cli.ts` that `spawnScrape` defaults to — forced down
 * its fast error arm with `--command /usr/bin/false` (no real claude/codex TUI,
 * no trust mutation), then posts the parsed {@link ScrapeResult} back to the test.
 * The test asserts the contract round-tripped (a real `error` arm, not a
 * `runner_failure` / empty_stdout). Uses `node:worker_threads` `parentPort` to
 * match the codebase's worker convention (not the web `self` global). Any message
 * triggers the scrape — the payload is unused.
 */

import { parentPort } from "node:worker_threads";
import { spawnScrape } from "../../src/usage-scrape-runner";

parentPort?.on("message", async () => {
  try {
    const result = await spawnScrape(
      { target: "codex", profile: "default", command: "/usr/bin/false" },
      { timeoutMs: 60_000 },
    );
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) });
  }
});
