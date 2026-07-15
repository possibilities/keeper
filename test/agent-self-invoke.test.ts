/**
 * Unit byte-pin for the detached pane's SELF-re-exec seam (fn-929.2). The
 * load-bearing invariant: the pane must re-exec `[<bun>, <abs cli/keeper.ts>,
 * "agent", <agent>, …]` — NEVER `process.argv[1]` (which is `daemon.ts` under
 * keeperd, `cli/keeper.ts` under the CLI, neither carrying the `agent` token).
 * A wrong-binary re-exec still returns a SUCCESS launch JSON, so the failure is
 * invisible until the K=3 never-bound breaker trips — hence the byte-pin here +
 * the real-pane assertion in the `.slow` sibling.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveKeeperAgentPath } from "../src/db";
import {
  buildLauncherArgvPrefix,
  defaultKeeperAgentPath,
  resolveKeeperAgentPathDepFree,
} from "../src/keeper-agent-path";

// The repo root from this test file's own location (test/ → ..).
const repoRoot = realpathSync(resolve(dirname(import.meta.dirname), "."));
const expectedDefault = realpathSync(join(repoRoot, "cli", "keeper.ts"));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-self-invoke-test-"));
}

describe("resolveKeeperAgentPathDepFree (cold-start / pair variant)", () => {
  test("default resolves the abs, symlink-resolved cli/keeper.ts path", () => {
    const got = resolveKeeperAgentPathDepFree({}, "/home/me");
    expect(got).toBe(expectedDefault);
    expect(got.startsWith("/")).toBe(true);
  });

  test("defaultKeeperAgentPath matches the empty-env resolve", () => {
    expect(defaultKeeperAgentPath()).toBe(expectedDefault);
  });

  test("KEEPER_AGENT_PATH env overrides", () => {
    expect(
      resolveKeeperAgentPathDepFree(
        { KEEPER_AGENT_PATH: "/custom/keeper.ts" },
        "/home/me",
      ),
    ).toBe("/custom/keeper.ts");
  });

  test("a tilde override expands at resolve time", () => {
    expect(
      resolveKeeperAgentPathDepFree(
        { KEEPER_AGENT_PATH: "~/code/keeper/cli/keeper.ts" },
        "/home/me",
      ),
    ).toBe("/home/me/code/keeper/cli/keeper.ts");
  });
});

describe("resolveKeeperAgentPath (config-aware, db.ts)", () => {
  // Run each db.ts-resolver case under a sandboxed env: a nonexistent
  // KEEPER_CONFIG so resolveConfig() yields no config keys, and the resolver's
  // own env knobs set per-case. Snapshot + restore so cases never leak.
  function withEnv(
    overrides: Record<string, string | undefined>,
    fn: () => void,
  ): void {
    const keys = ["KEEPER_CONFIG", "KEEPER_AGENT_PATH"];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];
    try {
      for (const k of keys) {
        const v = overrides[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k] as string;
      }
    }
  }

  const noConfig = join(tempDir(), "does-not-exist.yaml");

  test("KEEPER_AGENT_PATH env wins", () => {
    withEnv(
      { KEEPER_CONFIG: noConfig, KEEPER_AGENT_PATH: "/custom/keeper.ts" },
      () => {
        expect(resolveKeeperAgentPath()).toBe("/custom/keeper.ts");
      },
    );
  });

  test("the absolute derived default is returned when no override is set", () => {
    withEnv({ KEEPER_CONFIG: noConfig }, () => {
      const got = resolveKeeperAgentPath();
      expect(got.startsWith("/")).toBe(true);
      expect(got.endsWith("/cli/keeper.ts")).toBe(true);
    });
  });
});

describe("buildLauncherArgvPrefix is independent of argv[1]", () => {
  // The whole point: the prefix is computed from the resolver, NOT argv[1]. So
  // the daemon-context caller (argv[1]=daemon.ts) and the CLI-context caller
  // (argv[1]=cli/keeper.ts) produce a byte-identical prefix.
  test("identical prefix regardless of the synthetic argv[1]", () => {
    const fromDaemon = buildLauncherArgvPrefix(
      "/abs/bun",
      resolveKeeperAgentPathDepFree({}, "/home/me"),
    );
    const fromCli = buildLauncherArgvPrefix(
      "/abs/bun",
      resolveKeeperAgentPathDepFree({}, "/home/me"),
    );
    expect(fromDaemon).toEqual(fromCli);
    expect(fromDaemon).toEqual(["/abs/bun", expectedDefault, "agent"]);
  });
});

describe("cold-start variant is db.ts-free (hygiene grep)", () => {
  test("src/keeper-agent-path.ts imports no src/db.ts (no bun:sqlite drag)", () => {
    const src = readFileSync(
      join(repoRoot, "src", "keeper-agent-path.ts"),
      "utf8",
    );
    // Scan only the import statements (strip comments / prose mentions): an
    // `import … from "./db"` or `"bun:sqlite"` would drag the daemon's DB graph.
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .join("\n");
    expect(imports).not.toMatch(/from\s+["'][^"']*\bdb["']/);
    expect(imports).not.toMatch(/bun:sqlite/);
  });
});
