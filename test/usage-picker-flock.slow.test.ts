/**
 * Real multi-process flock-contention test for the credit-weighted picker,
 * extracted from `usage-picker.test.ts` into its own `*.slow.test.ts` because it
 * spawns ~30 real `bun` child processes (~5s wall-clock) — far heavier than the
 * rest of that file, which runs in-process and fast. There is no in-process
 * substitute: the test IS the thing under test (proving two OS processes respect
 * one flock), so it is demoted, not mocked. It is path-ignored from the fast
 * `bun run test` tier and still runs under `bun run test:full`.
 *
 * The `beforeEach`/`afterEach` setup and the `writeConfig`/`writeEnvelope`/
 * `readCounts` helpers are duplicated (minimally) from `usage-picker.test.ts`
 * rather than shared across test files; the same helpers stay in the fast file
 * for the ~21 in-process tests. `test/fixtures/pick-once.ts` is the child
 * entrypoint, referenced via `import.meta.dir`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { resetClock, setStateDir } from "../src/usage-picker";

let tmpDir: string;
let stateDir: string;
let configHome: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentusage-picker-"));
  stateDir = join(tmpDir, "state");
  mkdirSync(stateDir);
  configHome = join(tmpDir, "config");
  mkdirSync(join(configHome, "agentusage"), { recursive: true });
  setStateDir(stateDir);
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  resetClock();
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- helpers ---------------------------------------------------------

function writeConfig(profiles: string[]): void {
  const yaml = `profiles:\n${profiles.map((p) => `  - ${p}`).join("\n")}\n`;
  writeFileSync(join(configHome, "agentusage", "config.yaml"), yaml);
}

interface EnvelopeOpts {
  subscription_active: unknown;
  target?: string;
  status?: string;
}

function writeEnvelope(name: string, opts: EnvelopeOpts): void {
  const envelope: Record<string, unknown> = {
    schema_version: 1,
    id: name,
    target: opts.target ?? "claude",
    subscription_active: opts.subscription_active,
    status: opts.status ?? "active",
    usage: null,
    lift_at: null,
  };
  writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(envelope));
}

function readCounts(): Record<string, number> {
  const state = JSON.parse(readFileSync(join(stateDir, "picker.json"), "utf8"));
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(state.picks)) {
    out[name] = (entry as { count: number }).count;
  }
  return out;
}

// ---------- concurrency (the flock) -----------------------------------------

describe("concurrency", () => {
  test("concurrent picks across processes distribute evenly (real flock)", async () => {
    // Spawn N bun child processes each picking once against the shared ledger.
    // The flock serializes every read-modify-write across PROCESSES; without it
    // racing RMWs would lose updates (sum < N) and/or skew the distribution.
    writeConfig(["p1", "p2", "p3"]);
    for (const name of ["p1", "p2", "p3"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    const n = 30;
    const fixture = join(import.meta.dir, "fixtures", "pick-once.ts");
    const procs = Array.from({ length: n }, () =>
      spawn({
        cmd: ["bun", "run", fixture],
        env: {
          ...process.env,
          AGENTUSAGE_TEST_STATE_DIR: stateDir,
          XDG_CONFIG_HOME: configHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const results = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        const code = await p.exited;
        expect(code).toBe(0);
        return out.trim();
      }),
    );

    expect(results.every((r) => ["p1", "p2", "p3"].includes(r))).toBe(true);
    const counts = readCounts();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(n); // no lost updates
    const vals = Object.values(counts);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  }, 30000);
});
