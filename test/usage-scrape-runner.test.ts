/**
 * Unit pins for the keeper→`uv`→agentusage-util→JSON scrape seam
 * (`src/usage-scrape-runner.ts`, fn-930 `.3`). NO real `uv`/PTY here — the real
 * round-trip lives in the allowlisted `*.slow.test.ts`. This file drives:
 *
 *  - `parseScrapeStdout` over every discriminated arm: ok/subscribed (claude +
 *    codex), ok/no_subscription, error, and the runner_failure folds
 *    (empty stdout, non-JSON, schema mismatch, bad shape).
 *  - `buildScrapeArgs` argv assembly for BOTH legs — uv (`run --directory …`,
 *    never `--python`) and bun (`<bun> <dir>/src/scrape-cli.ts …`).
 *  - `resolveUsageScraperRuntimeKind`: env-over-config precedence, fail-closed to
 *    uv on garbage, uv default.
 *  - `resolveUsageScraperRuntime` gate: uv leg needs both keys; bun leg needs only
 *    the project dir (execPath bun default), null otherwise; tilde-expansion.
 *  - `withDirOnPath`: the tmux PATH augmentation the scrape child rides.
 *  - a synthetic `ScrapeRunner` stubbing the seam for the worker's branch logic.
 *  - the `KEEPER_AGENTUSAGE_ROOT` → `resolveUsageRoot()` override + picker
 *    `setStateDir` wiring, all sandbox-rooted (no real state dir touched).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveUsageRoot,
  resolveUsageScraperRuntime,
  resolveUsageScraperRuntimeKind,
  type UsageScraperRuntime,
} from "../src/db";
import { getStateDir, setStateDir } from "../src/usage-picker";
import {
  buildScrapeArgs,
  parseScrapeStdout,
  SCRAPE_CONTRACT_SCHEMA_VERSION,
  type ScrapeAccount,
  type ScrapeResult,
  type ScrapeRunner,
  withDirOnPath,
} from "../src/usage-scrape-runner";

// Env keys this suite mutates; saved/restored so it never leaks into siblings.
const ENV_KEYS = [
  "KEEPER_AGENTUSAGE_ROOT",
  "KEEPER_USAGE_SCRAPER_UV_PATH",
  "KEEPER_USAGE_SCRAPER_PROJECT_DIR",
  "KEEPER_USAGE_SCRAPER_RUNTIME",
  "KEEPER_USAGE_SCRAPER_BUN_PATH",
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

describe("buildScrapeArgs — uv leg", () => {
  const uv: UsageScraperRuntime = {
    runtime: "uv",
    uvPath: "/abs/uv",
    projectDir: "/abs/agentusage",
  };

  test("full argv: <uv> run --directory … python -m agentusage.scrape_cli; never --python", () => {
    const acct: ScrapeAccount = { target: "claude", profile: "work" };
    const args = buildScrapeArgs(uv, acct);
    expect(args).toEqual([
      "/abs/uv",
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
    const args = buildScrapeArgs(uv, acct);
    expect(args).toContain("--command");
    expect(args).toContain("/usr/bin/false");
    expect(args).toContain("--rows");
    expect(args).toContain("50");
    expect(args).toContain("--cols");
    expect(args).toContain("120");
  });
});

describe("buildScrapeArgs — bun leg", () => {
  const bun: UsageScraperRuntime = {
    runtime: "bun",
    bunPath: "/abs/bun",
    projectDir: "/abs/agentusage",
  };

  test("full argv: <bun> <dir>/src/scrape-cli.ts …; no uv `run`/`--python`", () => {
    const acct: ScrapeAccount = { target: "claude", profile: "work" };
    const args = buildScrapeArgs(bun, acct);
    expect(args).toEqual([
      "/abs/bun",
      "/abs/agentusage/src/scrape-cli.ts",
      "--target",
      "claude",
      "--profile",
      "work",
    ]);
    expect(args).not.toContain("run");
    expect(args).not.toContain("--python");
  });

  test("optional command/rows/cols passthrough preserved on the bun leg", () => {
    const acct: ScrapeAccount = {
      target: "codex",
      profile: "default",
      command: "/usr/bin/false",
      rows: 50,
      cols: 120,
    };
    const args = buildScrapeArgs(bun, acct);
    expect(args[0]).toBe("/abs/bun");
    expect(args[1]).toBe("/abs/agentusage/src/scrape-cli.ts");
    expect(args).toContain("--command");
    expect(args).toContain("/usr/bin/false");
    expect(args).toContain("--rows");
    expect(args).toContain("50");
    expect(args).toContain("--cols");
    expect(args).toContain("120");
  });
});

describe("resolveUsageScraperRuntimeKind — env-over-config, fail-closed", () => {
  function writeConfig(body: string): void {
    const cfgPath = join(tmpDir, "config.yaml");
    writeFileSync(cfgPath, body);
    process.env.KEEPER_CONFIG = cfgPath;
  }

  test("absent env + no config → uv (the shipped default)", () => {
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
  });

  test("env=bun → bun; env=uv → uv", () => {
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "bun";
    expect(resolveUsageScraperRuntimeKind()).toBe("bun");
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "uv";
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
  });

  test("an invalid env value fails closed to uv", () => {
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "python";
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
  });

  test("config usage_scraper_runtime: bun → bun when env is absent", () => {
    writeConfig("usage_scraper_runtime: bun\n");
    expect(resolveUsageScraperRuntimeKind()).toBe("bun");
  });

  test("a garbage config value fails closed to uv", () => {
    writeConfig("usage_scraper_runtime: nope\n");
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
  });

  test("a present env shadows config: env=uv beats config bun, garbage env still uv", () => {
    writeConfig("usage_scraper_runtime: bun\n");
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "uv";
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "garbage";
    expect(resolveUsageScraperRuntimeKind()).toBe("uv");
  });
});

describe("resolveUsageScraperRuntime — default (uv) gate", () => {
  test("both uv env keys set → resolves as the uv leg, tilde-expanded", () => {
    process.env.KEEPER_USAGE_SCRAPER_UV_PATH = "~/bin/uv";
    process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR = "/abs/agentusage";
    const rt = resolveUsageScraperRuntime();
    expect(rt).not.toBeNull();
    if (rt?.runtime !== "uv") throw new Error("expected the uv leg");
    expect(rt.uvPath).toBe(join(homedir(), "bin/uv"));
    expect(rt.projectDir).toBe("/abs/agentusage");
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

describe("resolveUsageScraperRuntime — bun leg (uv keys not required)", () => {
  test("runtime=bun + project dir → resolves with the execPath default, no uv keys", () => {
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "bun";
    process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR = "/abs/agentusage";
    const rt = resolveUsageScraperRuntime();
    expect(rt).not.toBeNull();
    if (rt?.runtime !== "bun") throw new Error("expected the bun leg");
    expect(rt.bunPath).toBe(process.execPath);
    expect(rt.projectDir).toBe("/abs/agentusage");
  });

  test("runtime=bun honors KEEPER_USAGE_SCRAPER_BUN_PATH, tilde-expanded", () => {
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "bun";
    process.env.KEEPER_USAGE_SCRAPER_PROJECT_DIR = "/abs/agentusage";
    process.env.KEEPER_USAGE_SCRAPER_BUN_PATH = "~/bin/bun";
    const rt = resolveUsageScraperRuntime();
    if (rt?.runtime !== "bun") throw new Error("expected the bun leg");
    expect(rt.bunPath).toBe(join(homedir(), "bin/bun"));
  });

  test("runtime=bun honors a usage_scraper_bun_path config override", () => {
    const cfgPath = join(tmpDir, "config.yaml");
    writeFileSync(
      cfgPath,
      "usage_scraper_runtime: bun\n" +
        "usage_scraper_project_dir: /abs/agentusage\n" +
        "usage_scraper_bun_path: /opt/bun/bin/bun\n",
    );
    process.env.KEEPER_CONFIG = cfgPath;
    const rt = resolveUsageScraperRuntime();
    if (rt?.runtime !== "bun") throw new Error("expected the bun leg");
    expect(rt.bunPath).toBe("/opt/bun/bin/bun");
    expect(rt.projectDir).toBe("/abs/agentusage");
  });

  test("runtime=bun still requires the project dir (gate closed without it)", () => {
    process.env.KEEPER_USAGE_SCRAPER_RUNTIME = "bun";
    expect(resolveUsageScraperRuntime()).toBeNull();
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
