/**
 * Unit pins for the `usage_models` keeper-config registry (`src/usage-models.ts`,
 * the db-free island the picker + producer share). Table-drives the pure
 * `parseUsageModels` fold, the `claudeProfileIds` / `hasCodexModel` /
 * `usageModelAliases` derivations, and the fail-open file read `resolveUsageModels`
 * against a `KEEPER_CONFIG`-redirected temp file. No daemon, no DB, no socket.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProfileIds,
  hasCodexModel,
  parseUsageModels,
  resolveUsageModels,
  type UsageModels,
  usageModelAliases,
} from "../src/usage-models";

// ---------- parseUsageModels (pure, table-driven) ---------------------------

// [label, raw input, expected registry] — every expected value is a hand-written
// constant, never re-derived from parseUsageModels itself.
const PARSE_CASES: Array<[string, unknown, UsageModels]> = [
  [
    "a valid map keeps ids + string aliases, null-aliases the rest",
    { default: "claude-0", "multi-claude-1": null, codex: "gpt" },
    { default: "claude-0", "multi-claude-1": null, codex: "gpt" },
  ],
  [
    "an id failing the [a-z0-9-]+ shape is dropped individually",
    { default: "claude-0", Bad_Id: "x", UPPER: "y", "dot.id": "z" },
    { default: "claude-0" },
  ],
  [
    "a non-string alias keeps the entry with a null alias (never un-declared)",
    { default: 7, "multi-claude-1": true, codex: { a: 1 } },
    { default: null, "multi-claude-1": null, codex: null },
  ],
  [
    "an empty-string alias folds to null (renders the raw id)",
    { default: "" },
    { default: null },
  ],
  ["a non-record string folds to {}", "not-a-map", {}],
  ["a non-record number folds to {}", 42, {}],
  ["an array folds to {} (a map is required)", ["default", "codex"], {}],
  ["null folds to {}", null, {}],
  ["undefined folds to {}", undefined, {}],
];

for (const [label, raw, expected] of PARSE_CASES) {
  test(`parseUsageModels: ${label}`, () => {
    expect(parseUsageModels(raw)).toEqual(expected);
  });
}

// ---------- derivations -----------------------------------------------------

test("claudeProfileIds returns every id except codex, in registry order", () => {
  const models: UsageModels = {
    default: "claude-0",
    codex: "gpt",
    "multi-claude-1": null,
  };
  expect(claudeProfileIds(models)).toEqual(["default", "multi-claude-1"]);
});

test("claudeProfileIds is [] on an empty registry", () => {
  expect(claudeProfileIds({})).toEqual([]);
});

test("claudeProfileIds is [] on a codex-only registry", () => {
  expect(claudeProfileIds({ codex: null })).toEqual([]);
});

test("hasCodexModel is true iff codex is declared", () => {
  expect(hasCodexModel({ codex: null })).toBe(true);
  expect(hasCodexModel({ codex: "gpt", default: null })).toBe(true);
  expect(hasCodexModel({ default: "claude-0" })).toBe(false);
  expect(hasCodexModel({})).toBe(false);
});

test("usageModelAliases keeps only the non-null aliases", () => {
  const models: UsageModels = {
    default: "claude-0",
    "multi-claude-1": null,
    codex: "gpt",
  };
  expect(usageModelAliases(models)).toEqual({
    default: "claude-0",
    codex: "gpt",
  });
});

test("usageModelAliases is {} when nothing is aliased", () => {
  expect(usageModelAliases({ default: null, codex: null })).toEqual({});
});

// ---------- resolveUsageModels (fail-open file read) ------------------------

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-models-"));
  prevEnv = process.env.KEEPER_CONFIG;
  // Point at a not-yet-written path so an un-writing test fail-opens instead of
  // reading the real ~/.config/keeper/config.yaml.
  process.env.KEEPER_CONFIG = join(dir, "config.yaml");
});

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = prevEnv;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  writeFileSync(join(dir, "config.yaml"), yaml);
}

test("resolveUsageModels reads usage_models from the KEEPER_CONFIG file", () => {
  writeConfig("usage_models:\n  default: claude-0\n  codex:\n");
  expect(resolveUsageModels()).toEqual({ default: "claude-0", codex: null });
});

test("resolveUsageModels fail-opens to {} on a missing file", () => {
  expect(resolveUsageModels()).toEqual({});
});

test("resolveUsageModels fail-opens to {} on malformed YAML", () => {
  writeConfig("usage_models: : : not yaml\n  - broken\n");
  expect(resolveUsageModels()).toEqual({});
});

test("resolveUsageModels fail-opens to {} when the key is absent", () => {
  writeConfig("roots:\n  - ~/code\n");
  expect(resolveUsageModels()).toEqual({});
});
