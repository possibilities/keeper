/**
 * Unit pins for the keeper→bun→internal-scrape-cli→JSON scrape seam
 * (`src/usage-scrape-runner.ts`). NO real subprocess/PTY here — the real
 * round-trip lives in the allowlisted `*.slow.test.ts`. This file drives:
 *
 *  - `parseScrapeStdout` over every discriminated arm: ok/subscribed (claude +
 *    codex), ok/no_subscription, error, and the runner_failure folds
 *    (empty stdout, non-JSON, schema mismatch, bad shape).
 *  - `buildScrapeArgs`: the ONE fixed argv shape — `[process.execPath, <internal
 *    scrape-cli>, --target …, --profile …]` — including the injectable entry path
 *    and its default resolution.
 *  - `spawnScrape`: the `spawn_failed` fold via the entry-path seam (an off-tree
 *    entry relocates the derived cwd → Bun.spawn throws synchronously, no child).
 *  - `withDirOnPath`: the tmux PATH augmentation the scrape child rides.
 *  - a synthetic `ScrapeRunner` stubbing the seam for the worker's branch logic.
 *  - the `KEEPER_AGENTUSAGE_ROOT` → `resolveUsageRoot()` override + picker
 *    `setStateDir` wiring, all sandbox-rooted (no real state dir touched).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUsageRoot } from "../src/db";
import { getStateDir, setStateDir } from "../src/usage-picker";
import {
  buildScrapeArgs,
  defaultScrapeCliPath,
  parseScrapeStdout,
  SCRAPE_CONTRACT_SCHEMA_VERSION,
  type ScrapeAccount,
  type ScrapeResult,
  type ScrapeRunner,
  spawnScrape,
  withDirOnPath,
} from "../src/usage-scrape-runner";

// Env keys this suite mutates; saved/restored so it never leaks into siblings.
const ENV_KEYS = ["KEEPER_AGENTUSAGE_ROOT", "KEEPER_CONFIG"];
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
    if (r.kind !== "ok" || "signed_out" in r || r.no_subscription)
      throw new Error("wrong arm");
    expect(r.subscription_active).toBe(true);
    expect(r.usage.session?.percent_used).toBe(12.5);
    expect(r.usage.sonnet_week?.percent_used).toBe(5);
  });

  test("codex subscribed → subscription_active null, optional spark buckets", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "ok",
      usage: {
        session: { percent_used: 0, resets_at: null },
        codex_spark_session: { percent_used: 27, resets_at: null },
        codex_spark_week: { percent_used: 48, resets_at: null },
      },
      subscription_active: null,
    });
    const r = parseScrapeStdout(json, "", 0);
    if (r.kind !== "ok" || "signed_out" in r || r.no_subscription)
      throw new Error("wrong arm");
    expect(r.subscription_active).toBeNull();
    expect(r.usage.sonnet_week).toBeUndefined();
    expect(r.usage.codex_spark_session?.percent_used).toBe(27);
    expect(r.usage.codex_spark_week?.percent_used).toBe(48);
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
    if (r.kind !== "ok" || "signed_out" in r) throw new Error("wrong arm");
    expect(r.no_subscription).toBe(true);
  });
});

describe("parseScrapeStdout — ok/signed_out (fn-1007)", () => {
  test("signed_out:true → the success signed-out arm, no usage", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "ok",
      signed_out: true,
    });
    const r = parseScrapeStdout(json, "", 0);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok" || !("signed_out" in r)) throw new Error("wrong arm");
    expect(r.signed_out).toBe(true);
  });

  test("signed_out is checked BEFORE no_subscription and the usage block", () => {
    // A (degenerate) contract carrying both flags + usage must resolve to the
    // signed-out arm — signed_out has precedence in the ok-block.
    const json = JSON.stringify({
      schema_version: 1,
      status: "ok",
      signed_out: true,
      no_subscription: true,
      usage: { session: { percent_used: 9, resets_at: null } },
    });
    const r = parseScrapeStdout(json, "", 0);
    if (r.kind !== "ok") throw new Error("wrong arm");
    expect("signed_out" in r).toBe(true);
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

  test("v2 error arm carries a stable error_kind", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "error",
      error_type: "ClaudeUsageParseError",
      message: "panel never rendered",
      screen_excerpt: [],
      error_kind: "panel_missing",
    });
    const r = parseScrapeStdout(json, "", 1);
    if (r.kind !== "error") throw new Error("wrong arm");
    expect(r.error_kind).toBe("panel_missing");
  });

  test("v1 error arm (no error_kind) → error_kind null", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "error",
      error_type: "ClaudeUsageParseError",
      message: "drift",
      screen_excerpt: [],
    });
    const r = parseScrapeStdout(json, "", 1);
    if (r.kind !== "error") throw new Error("wrong arm");
    expect(r.error_kind).toBeNull();
  });

  test("an unknown/garbage error_kind folds to null (forward-compat)", () => {
    const json = JSON.stringify({
      schema_version: 1,
      status: "error",
      error_type: "X",
      message: "m",
      screen_excerpt: [],
      error_kind: "not_a_real_kind",
    });
    const r = parseScrapeStdout(json, "", 1);
    if (r.kind !== "error") throw new Error("wrong arm");
    expect(r.error_kind).toBeNull();
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

describe("buildScrapeArgs — one fixed shape", () => {
  test("full argv: <bun> <internal scrape-cli> --target … --profile …; no runtime fork remnants", () => {
    const acct: ScrapeAccount = { target: "claude", profile: "work" };
    const args = buildScrapeArgs(
      acct,
      "/abs/keeper/src/usage-scrape/scrape-cli.ts",
    );
    expect(args).toEqual([
      process.execPath,
      "/abs/keeper/src/usage-scrape/scrape-cli.ts",
      "--target",
      "claude",
      "--profile",
      "work",
    ]);
    // No uv `run --directory … --python` remnants survive the collapse.
    expect(args).not.toContain("run");
    expect(args).not.toContain("--directory");
    expect(args).not.toContain("--python");
  });

  test("defaults to the internal scrape-cli entry when no override is given", () => {
    const args = buildScrapeArgs({ target: "codex", profile: "default" });
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toBe(defaultScrapeCliPath());
    // The internal entry is this repo's first-class source, not an external dir.
    expect(args[1]?.endsWith("/src/usage-scrape/scrape-cli.ts")).toBe(true);
  });

  test("optional command/rows/cols appended when present", () => {
    const acct: ScrapeAccount = {
      target: "codex",
      profile: "default",
      command: "/usr/bin/false",
      rows: 50,
      cols: 120,
    };
    const args = buildScrapeArgs(acct, "/e/scrape-cli.ts");
    expect(args).toContain("--command");
    expect(args).toContain("/usr/bin/false");
    expect(args).toContain("--rows");
    expect(args).toContain("50");
    expect(args).toContain("--cols");
    expect(args).toContain("120");
  });
});

describe("spawnScrape — spawn_failed via the entry-path seam", () => {
  test("an off-tree entry override relocates cwd to a missing dir → spawn_failed, no child", async () => {
    // The child cwd derives from the entry's repo root; a nonexistent root makes
    // Bun.spawn throw synchronously, folding to the spawn_failed arm WITHOUT ever
    // starting a subprocess (fast-tier safe). `ghost-root` is never created, so
    // its derived cwd `<tmpDir>/ghost-root` does not exist.
    const entryPath = join(
      tmpDir,
      "ghost-root",
      "src",
      "usage-scrape",
      "scrape-cli.ts",
    );
    const r = await spawnScrape(
      { target: "claude", profile: "p" },
      { entryPath },
    );
    if (r.kind !== "runner_failure") throw new Error("expected runner_failure");
    expect(r.reason).toBe("spawn_failed");
    expect(r.exitCode).toBeNull();
  });
});

describe("withDirOnPath — tmux PATH augmentation (pure)", () => {
  test("appends the dir when absent", () => {
    expect(withDirOnPath("/usr/bin:/bin", "/opt/homebrew/bin")).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin",
    );
  });

  test("does not duplicate a dir already on PATH", () => {
    expect(
      withDirOnPath("/usr/bin:/opt/homebrew/bin", "/opt/homebrew/bin"),
    ).toBe("/usr/bin:/opt/homebrew/bin");
  });

  test("returns just the dir when the base PATH is empty or undefined", () => {
    expect(withDirOnPath(undefined, "/opt/homebrew/bin")).toBe(
      "/opt/homebrew/bin",
    );
    expect(withDirOnPath("", "/opt/homebrew/bin")).toBe("/opt/homebrew/bin");
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
