/**
 * Unit pins for the keeper→`uv`→agentusage-util→JSON scrape seam
 * (`src/usage-scrape-runner.ts`, fn-930 `.3`). NO real `uv`/PTY here — the real
 * round-trip lives in the allowlisted `*.slow.test.ts`. This file drives:
 *
 *  - `parseScrapeStdout` over every discriminated arm: ok/subscribed (claude +
 *    codex), ok/no_subscription, error, and the runner_failure folds
 *    (empty stdout, non-JSON, schema mismatch, bad shape).
 *  - `buildScrapeArgs` argv assembly (plain `run --directory`, never `--python`).
 *  - `resolveUsageScraperRuntime` gate: both keys → resolve; either unset → null;
 *    env override + tilde-expansion.
 *  - a synthetic `ScrapeRunner` stubbing the seam for the worker's branch logic.
 *  - the `KEEPER_AGENTUSAGE_ROOT` → `resolveUsageRoot()` override + picker
 *    `setStateDir` wiring, all sandbox-rooted (no real state dir touched).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUsageRoot, resolveUsageScraperRuntime } from "../src/db";
import { getStateDir, setStateDir } from "../src/usage-picker";
import {
  buildScrapeArgs,
  parseScrapeStdout,
  SCRAPE_CONTRACT_SCHEMA_VERSION,
  type ScrapeAccount,
  type ScrapeResult,
  type ScrapeRunner,
} from "../src/usage-scrape-runner";

// Env keys this suite mutates; saved/restored so it never leaks into siblings.
const ENV_KEYS = [
  "KEEPER_AGENTUSAGE_ROOT",
  "KEEPER_USAGE_SCRAPER_UV_PATH",
  "KEEPER_USAGE_SCRAPER_PROJECT_DIR",
  "KEEPER_CONFIG",
];
let saved: Record<string, string | undefined>;
let savedStateDir: string;
let tmpDir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  savedStateDir = getStateDir();
  tmpDir = mkdtempSync(join(tmpdir(), "usage-scrape-runner-"));
  // Point config at an absent file so resolveConfig() yields no scraper keys.
  process.env.KEEPER_CONFIG = join(tmpDir, "no-such-config.yaml");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setStateDir(savedStateDir);
  rmSync(tmpDir, { recursive: true, force: true });
});

function okSubscribed(): string {
  return JSON.stringify({
    schema_version: SCRAPE_CONTRACT_SCHEMA_VERSION,
    status: "ok",
    usage: {
      session: { percent_used: 12.5, resets_at: "2026-06-24T18:00:00-07:00" },
      week: { percent_used: 40, resets_at: null },
      sonnet_week: { percent_used: 5, resets_at: null },
    },
    subscription_active: true,
  });
}

describe("parseScrapeStdout — ok/subscribed", () => {
  test("claude subscribed → ok with usage + subscription_active true", () => {
    const r = parseScrapeStdout(okSubscribed(), "", 0);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok" || r.no_subscription) throw new Error("wrong arm");
    expect(r.subscription_active).toBe(true);
    expect(r.usage.session?.percent_used).toBe(12.5);
    expect(r.usage.sonnet_week?.percent_used).toBe(5);
  });

  test("codex subscribed → subscription_active null, no sonnet_week", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "ok",
      usage: { session: { percent_used: 0, resets_at: null } },
      subscription_active: null,
    });
    const r = parseScrapeStdout(json, "", 0);
    if (r.kind !== "ok" || r.no_subscription) throw new Error("wrong arm");
    expect(r.subscription_active).toBeNull();
    expect(r.usage.sonnet_week).toBeUndefined();
  });
});

describe("parseScrapeStdout — ok/no_subscription", () => {
  test("no_subscription:true → the success no-sub arm, no usage", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "ok",
      no_subscription: true,
    });
    const r = parseScrapeStdout(json, "", 0);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("wrong arm");
    expect(r.no_subscription).toBe(true);
  });
});

describe("parseScrapeStdout — error", () => {
  test("error arm carries error_type, message, screen_excerpt", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "error",
      error_type: "ClaudeUsageParseError",
      message: "panel never rendered",
      screen_excerpt: ["line one", "line two"],
    });
    const r = parseScrapeStdout(json, "Traceback…", 1);
    if (r.kind !== "error") throw new Error("wrong arm");
    expect(r.error_type).toBe("ClaudeUsageParseError");
    expect(r.message).toBe("panel never rendered");
    expect(r.screen_excerpt).toEqual(["line one", "line two"]);
  });

  test("error arm tolerates a non-array screen_excerpt → empty list", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "error",
      error_type: "X",
      message: "m",
      screen_excerpt: null,
    });
    const r = parseScrapeStdout(json, "", 1);
    if (r.kind !== "error") throw new Error("wrong arm");
    expect(r.screen_excerpt).toEqual([]);
  });
});

describe("parseScrapeStdout — runner_failure folds (no throw)", () => {
  test("empty stdout → empty_stdout (Bun#24690 guard), carries stderr", () => {
    const r = parseScrapeStdout("   \n", "boom on stderr", 0);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("empty_stdout");
    expect(r.stderr).toBe("boom on stderr");
  });

  test("non-JSON stdout → non_json", () => {
    const r = parseScrapeStdout("not json at all", "", 0);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("non_json");
  });

  test("schema_version mismatch → schema_mismatch", () => {
    const json = JSON.stringify({ schema_version: 2, status: "ok", usage: {} });
    const r = parseScrapeStdout(json, "", 0);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("schema_mismatch");
  });

  test("ok status with neither usage nor no_subscription → bad_shape", () => {
    const json = JSON.stringify({ schema_version: 1, status: "ok" });
    const r = parseScrapeStdout(json, "", 0);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("bad_shape");
  });

  test("non-object JSON (array) → bad_shape", () => {
    const r = parseScrapeStdout("[1,2,3]", "", 0);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("bad_shape");
  });

  test("unknown status → bad_shape, exitCode threaded through", () => {
    const json = JSON.stringify({ schema_version: 1, status: "weird" });
    const r = parseScrapeStdout(json, "", 7);
    if (r.kind !== "runner_failure") throw new Error("wrong arm");
    expect(r.reason).toBe("bad_shape");
    expect(r.exitCode).toBe(7);
  });
});

describe("buildScrapeArgs", () => {
  test("plain `run --directory`, never `--python`; claude profile threaded", () => {
    const acct: ScrapeAccount = { target: "claude", profile: "work" };
    const args = buildScrapeArgs("/abs/agentusage", acct);
    expect(args).toEqual([
      "run",
      "--directory",
      "/abs/agentusage",
      "python",
      "-m",
      "agentusage.scrape_cli",
      "--target",
      "claude",
      "--profile",
      "work",
    ]);
    expect(args).not.toContain("--python");
  });

  test("optional command/rows/cols appended when present", () => {
    const acct: ScrapeAccount = {
      target: "codex",
      profile: "default",
      command: "/usr/bin/false",
      rows: 50,
      cols: 120,
    };
    const args = buildScrapeArgs("/p", acct);
    expect(args).toContain("--command");
    expect(args).toContain("/usr/bin/false");
    expect(args).toContain("--rows");
    expect(args).toContain("50");
    expect(args).toContain("--cols");
    expect(args).toContain("120");
  });
});

describe("resolveUsageScraperRuntime — no-default gate", () => {
  test("both env keys set → resolves, tilde-expanded", () => {
    process.env.KEEPER_USAGE_SCRAPER_UV_PATH = "~/bin/uv";
    process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR = "/abs/agentusage";
    const rt = resolveUsageScraperRuntime();
    expect(rt).not.toBeNull();
    expect(rt?.uvPath).toBe(join(homedir(), "bin/uv"));
    expect(rt?.projectDir).toBe("/abs/agentusage");
  });

  test("uv path set but project dir unset → null (gate closed)", () => {
    process.env.KEEPER_USAGE_SCRAPER_UV_PATH = "/opt/uv";
    expect(resolveUsageScraperRuntime()).toBeNull();
  });

  test("project dir set but uv path unset → null (gate closed)", () => {
    process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR = "/abs/agentusage";
    expect(resolveUsageScraperRuntime()).toBeNull();
  });

  test("neither set → null", () => {
    expect(resolveUsageScraperRuntime()).toBeNull();
  });
});

describe("KEEPER_AGENTUSAGE_ROOT override + picker setStateDir wiring", () => {
  test("env override moves resolveUsageRoot off the real state dir", () => {
    const root = join(tmpDir, "agentusage");
    process.env.KEEPER_AGENTUSAGE_ROOT = root;
    expect(resolveUsageRoot()).toBe(root);
    // And the same root drives the vendored picker's ledger location.
    setStateDir(resolveUsageRoot());
    expect(getStateDir()).toBe(root);
    expect(getStateDir()).not.toBe(
      join(homedir(), ".local", "state", "agentusage"),
    );
  });
});

describe("synthetic ScrapeRunner (the worker's injection point)", () => {
  test("a stub runner returns the canned arm the worker branches on", async () => {
    const calls: ScrapeAccount[] = [];
    const stub: ScrapeRunner = async (acct) => {
      calls.push(acct);
      const canned: ScrapeResult = {
        kind: "ok",
        no_subscription: false,
        usage: { session: { percent_used: 0, resets_at: null } },
        subscription_active: true,
      };
      return canned;
    };
    const r = await stub({ target: "claude", profile: "p" });
    expect(r.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile).toBe("p");
  });
});
