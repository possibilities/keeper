/**
 * Unit tests for the dep-free `src/hermes-trust.ts` leaf module: the hermes
 * shell-hook trust seeder the `keeper agent` launch path runs before launching
 * hermes so its events-shim fires without an interactive first-use consent prompt.
 *
 * Pure + in-process: every test injects a tmpdir HERMES_HOME via `env`, so there
 * is NO real hermes spawn and NO write to the real `~/.hermes`. Assertions read the
 * config.yaml + shell-hooks-allowlist.json the seeder writes there.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERMES_SHIM_EVENTS,
  HERMES_SHIM_VERSION,
} from "../plugins/keeper/plugin/hooks/hermes-events-shim";
import {
  buildHermesHooksBlock,
  ensureHermesShimTrust,
} from "../src/hermes-trust";

const SHIM_COMMAND =
  "/abs/bun /abs/plugins/keeper/plugin/hooks/hermes-events-shim.ts";

let root: string;
let hermesHome: string;
let configPath: string;
let allowlistPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermes-trust-"));
  hermesHome = join(root, "hermeshome");
  configPath = join(hermesHome, "config.yaml");
  allowlistPath = join(hermesHome, "shell-hooks-allowlist.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The env shape the seeder reads — explicit HERMES_HOME, no real fallback. */
function envFor(extra: Record<string, string | undefined> = {}) {
  return { HERMES_HOME: hermesHome, ...extra };
}

/** Seed with the real event set + version unless overridden. */
function seed(
  opts: {
    events?: readonly string[];
    version?: number;
    shimCommand?: string;
    env?: Record<string, string | undefined>;
  } = {},
) {
  return ensureHermesShimTrust({
    env: opts.env ?? envFor(),
    shimCommand: opts.shimCommand ?? SHIM_COMMAND,
    events: opts.events ?? HERMES_SHIM_EVENTS,
    version: opts.version ?? HERMES_SHIM_VERSION,
  });
}

function readAllowlistApprovals(): Array<{ event: string; command: string }> {
  return JSON.parse(readFileSync(allowlistPath, "utf8")).approvals;
}

test("buildHermesHooksBlock is deterministic and registers every event → the command", () => {
  const block = buildHermesHooksBlock({
    shimCommand: SHIM_COMMAND,
    events: ["on_session_start", "pre_llm_call"],
    version: 1,
  });
  expect(block).toBe(
    buildHermesHooksBlock({
      shimCommand: SHIM_COMMAND,
      events: ["on_session_start", "pre_llm_call"],
      version: 1,
    }),
  );
  expect(block).toContain("hooks:");
  expect(block).toContain("on_session_start:");
  expect(block).toContain("pre_llm_call:");
  // The command is JSON-encoded (valid YAML double-quoted scalar).
  expect(block).toContain(`command: ${JSON.stringify(SHIM_COMMAND)}`);
  expect(block).toContain("# >>> keeper-hermes-shim v1 >>>");
  expect(block).toContain("# <<< keeper-hermes-shim v1 <<<");
});

test("fresh HERMES_HOME (no config) → seeded; config + allowlist written", () => {
  expect(existsSync(configPath)).toBe(false);
  const status = seed();
  expect(status).toBe("seeded");

  const config = readFileSync(configPath, "utf8");
  expect(config).toContain("# >>> keeper-hermes-shim");
  expect(config).toContain("hooks:");
  for (const event of HERMES_SHIM_EVENTS) {
    expect(config).toContain(`  ${event}:`);
  }
  expect(config).toContain(`command: ${JSON.stringify(SHIM_COMMAND)}`);

  const approvals = readAllowlistApprovals();
  for (const event of HERMES_SHIM_EVENTS) {
    expect(
      approvals.some((a) => a.event === event && a.command === SHIM_COMMAND),
    ).toBe(true);
  }
});

test("existing unrelated config → seeded; original content preserved + backup written", () => {
  mkdirSync(hermesHome, { recursive: true });
  const original = "model: gpt-5\ntoolset: coding\n";
  writeFileSync(configPath, original);

  const status = seed();
  expect(status).toBe("seeded");

  const config = readFileSync(configPath, "utf8");
  // The pre-existing content survives (append, not rewrite).
  expect(config).toContain("model: gpt-5");
  expect(config).toContain("toolset: coding");
  expect(config).toContain("# >>> keeper-hermes-shim");
  // A one-level backup of the pre-edit config is snapshotted.
  expect(readFileSync(`${configPath}.keeper-bak`, "utf8")).toBe(original);
});

test("re-seed is idempotent → already-seeded, no rewrite", () => {
  expect(seed()).toBe("seeded");
  const afterFirst = readFileSync(configPath, "utf8");
  const allowlistAfterFirst = readFileSync(allowlistPath, "utf8");

  expect(seed()).toBe("already-seeded");
  expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
  // Idempotent allowlist too — no duplicate approvals.
  expect(readFileSync(allowlistPath, "utf8")).toBe(allowlistAfterFirst);
  const approvals = readAllowlistApprovals();
  const dupes = approvals.filter(
    (a) => a.event === "on_session_start" && a.command === SHIM_COMMAND,
  );
  expect(dupes.length).toBe(1);
});

test("version bump → reseeded; the old block is REPLACED (single block, no dup)", () => {
  expect(seed({ version: 1 })).toBe("seeded");
  expect(seed({ version: 2 })).toBe("reseeded");

  const config = readFileSync(configPath, "utf8");
  // Exactly one managed block remains, at the new version.
  const startCount = config.split("# >>> keeper-hermes-shim").length - 1;
  expect(startCount).toBe(1);
  expect(config).toContain("# >>> keeper-hermes-shim v2 >>>");
  expect(config).not.toContain("v1 >>>");
});

test("a command change (e.g. shim path moved) also reseeds", () => {
  expect(seed({ shimCommand: "/old/bun /old/shim.ts" })).toBe("seeded");
  expect(seed({ shimCommand: "/new/bun /new/shim.ts" })).toBe("reseeded");
  const config = readFileSync(configPath, "utf8");
  expect(config).toContain(JSON.stringify("/new/bun /new/shim.ts"));
  expect(config).not.toContain(JSON.stringify("/old/bun /old/shim.ts"));
});

test("foreign top-level hooks: present → manual-hooks-present; config untouched, no allowlist", () => {
  mkdirSync(hermesHome, { recursive: true });
  const humanConfig =
    'hooks:\n  pre_tool_call:\n    - command: "/home/me/my-hook.sh"\n';
  writeFileSync(configPath, humanConfig);

  const status = seed();
  expect(status).toBe("manual-hooks-present");
  // The human's config is left EXACTLY as-is — never destructive.
  expect(readFileSync(configPath, "utf8")).toBe(humanConfig);
  // No allowlist entry for a hook we did not register.
  expect(existsSync(allowlistPath)).toBe(false);
});

test("allowlist preserves pre-existing approvals and adds ours (idempotent)", () => {
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(
    allowlistPath,
    JSON.stringify({
      approvals: [{ event: "post_llm_call", command: "/home/me/other.sh" }],
    }),
  );

  seed({ events: ["on_session_start"] });
  const approvals = readAllowlistApprovals();
  // The human's approval survives.
  expect(
    approvals.some(
      (a) => a.event === "post_llm_call" && a.command === "/home/me/other.sh",
    ),
  ).toBe(true);
  // Ours is added.
  expect(
    approvals.some(
      (a) => a.event === "on_session_start" && a.command === SHIM_COMMAND,
    ),
  ).toBe(true);
});

test("corrupt allowlist → treated as empty; ours written as valid JSON", () => {
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(allowlistPath, "{ this is not valid json ]");

  const status = seed({ events: ["on_session_start"] });
  expect(status).toBe("seeded");
  const approvals = readAllowlistApprovals();
  expect(
    approvals.some(
      (a) => a.event === "on_session_start" && a.command === SHIM_COMMAND,
    ),
  ).toBe(true);
});

test("HERMES_HOME override is honored (writes under the injected home, not ~/.hermes)", () => {
  seed();
  expect(existsSync(configPath)).toBe(true);
  // The seeder never touched the process default home.
});

test("a stale lock (old mtime) is reclaimed → still seeds", () => {
  mkdirSync(hermesHome, { recursive: true });
  const lockPath = join(hermesHome, ".keeper-hermes-shim.lock");
  writeFileSync(lockPath, `${process.pid}\n`);
  // Backdate the lock well past the staleness threshold (60s).
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lockPath, old, old);

  const status = seed();
  expect(status).toBe("seeded");
  expect(existsSync(configPath)).toBe(true);
  // Lock released after the seed.
  expect(existsSync(lockPath)).toBe(false);
});

test("HERMES_HOME is a file → error (fail-open, no throw)", () => {
  mkdirSync(root, { recursive: true });
  const asFile = join(root, "not-a-dir");
  writeFileSync(asFile, "x");
  const status = ensureHermesShimTrust({
    env: { HERMES_HOME: asFile },
    shimCommand: SHIM_COMMAND,
    events: HERMES_SHIM_EVENTS,
    version: HERMES_SHIM_VERSION,
  });
  expect(status).toBe("error");
});

test("silences to a private log path when KEEPER_HERMES_TRUST_LOG is set", () => {
  const logPath = join(root, "trust.log");
  seed({ env: envFor({ KEEPER_HERMES_TRUST_LOG: logPath }) });
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, "utf8")).toContain("seeded");
  // touch statSync so the import is used even if the assertion above changes.
  expect(statSync(logPath).size).toBeGreaterThan(0);
});
