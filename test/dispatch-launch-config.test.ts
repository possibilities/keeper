/**
 * Dispatch-table launch-config resolver (ADR 0040): per-verb-class floors,
 * the warn-once memo, and `approve` resolving through `work`. Fixture configs
 * only — the live ~/.config is arthack-owned stow state we must not touch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDispatchLaunchConfig } from "../src/dispatch-launch-config";
import {
  ESCALATION_EFFORT,
  ESCALATION_MODEL,
  WORKER_EFFORT,
  WORKER_MODEL,
} from "../src/reconcile-core";

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-dispatch-launch-config-"));
  savedConfigDir = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = tmpDir;
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.KEEPER_CONFIG_DIR;
  else process.env.KEEPER_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, body);
  return p;
}

const WORKER_FLOOR = { model: WORKER_MODEL, effort: WORKER_EFFORT };
const ESCALATION_FLOOR = { model: ESCALATION_MODEL, effort: ESCALATION_EFFORT };

describe("resolveDispatchLaunchConfig — absent file", () => {
  test("work/close/resolve float to the worker constants", () => {
    const missing = join(tmpDir, "nope.yaml");
    expect(resolveDispatchLaunchConfig("work", missing)).toEqual(WORKER_FLOOR);
    expect(resolveDispatchLaunchConfig("close", missing)).toEqual(WORKER_FLOOR);
    expect(resolveDispatchLaunchConfig("resolve", missing)).toEqual(
      WORKER_FLOOR,
    );
    // The constants pin sonnet/max by default.
    expect(resolveDispatchLaunchConfig("work", missing)).toEqual({
      model: "sonnet",
      effort: "max",
    });
  });

  test("unblock/deconflict/repair float to the escalation constants", () => {
    const missing = join(tmpDir, "nope.yaml");
    expect(resolveDispatchLaunchConfig("unblock", missing)).toEqual(
      ESCALATION_FLOOR,
    );
    expect(resolveDispatchLaunchConfig("deconflict", missing)).toEqual(
      ESCALATION_FLOOR,
    );
    expect(resolveDispatchLaunchConfig("repair", missing)).toEqual(
      ESCALATION_FLOOR,
    );
    // The constants pin sonnet/high by default.
    expect(resolveDispatchLaunchConfig("unblock", missing)).toEqual({
      model: "sonnet",
      effort: "high",
    });
  });

  test("handoff floats to fully-absent (no compiled default)", () => {
    const missing = join(tmpDir, "nope.yaml");
    expect(resolveDispatchLaunchConfig("handoff", missing)).toEqual({});
  });
});

describe("resolveDispatchLaunchConfig — malformed catalog", () => {
  test("a malformed dispatch triple floors EVERY verb (whole-file-to-floor)", () => {
    const p = writeYaml("presets.yaml", "dispatch:\n  work: not-a-triple\n");
    expect(resolveDispatchLaunchConfig("work", p)).toEqual(WORKER_FLOOR);
    expect(resolveDispatchLaunchConfig("unblock", p)).toEqual(ESCALATION_FLOOR);
    expect(resolveDispatchLaunchConfig("handoff", p)).toEqual({});
  });

  test("a malformed triple ELSEWHERE in the catalog also floors dispatch (no per-verb salvage)", () => {
    const p = writeYaml(
      "presets.yaml",
      "claude_default: claude::opus\ndispatch:\n  work: claude::sonnet::max\n",
    );
    expect(resolveDispatchLaunchConfig("work", p)).toEqual(WORKER_FLOOR);
  });

  test("an unknown top-level key floors dispatch", () => {
    const p = writeYaml("presets.yaml", "bogus: 1\n");
    expect(resolveDispatchLaunchConfig("work", p)).toEqual(WORKER_FLOOR);
  });
});

describe("resolveDispatchLaunchConfig — absent row", () => {
  test("a valid catalog with no dispatch table floors every verb", () => {
    const p = writeYaml("presets.yaml", "worker: claude::sonnet::max\n");
    expect(resolveDispatchLaunchConfig("work", p)).toEqual(WORKER_FLOOR);
    expect(resolveDispatchLaunchConfig("repair", p)).toEqual(ESCALATION_FLOOR);
  });

  test("an unset row within an otherwise-populated table floors just that verb", () => {
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  work: claude::opus::xhigh\n",
    );
    expect(resolveDispatchLaunchConfig("work", p)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "xhigh",
    });
    expect(resolveDispatchLaunchConfig("close", p)).toEqual(WORKER_FLOOR);
  });
});

describe("resolveDispatchLaunchConfig — configured row", () => {
  test("returns the configured triple's fields, harness carried through", () => {
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  unblock: claude::haiku::low\n",
    );
    expect(resolveDispatchLaunchConfig("unblock", p)).toEqual({
      harness: "claude",
      model: "haiku",
      effort: "low",
    });
  });
});

describe("resolveDispatchLaunchConfig — non-claude harness", () => {
  test("resolves floor behavior (model/effort still applied) and warns once per (verb, harness)", () => {
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  work: codex::gpt::high\n",
    );
    const warned = new Set<string>();
    const first = resolveDispatchLaunchConfig("work", p, warned);
    expect(first).toEqual({ harness: "codex", model: "gpt", effort: "high" });
    expect(warned.has("work::codex")).toBe(true);
    expect(warned.size).toBe(1);

    // A second call with the SAME memo does not add a duplicate entry.
    resolveDispatchLaunchConfig("work", p, warned);
    expect(warned.size).toBe(1);
  });

  test("a distinct verb sharing the same harness warns under its own key", () => {
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  work: codex::gpt::high\n  close: codex::gpt::high\n",
    );
    const warned = new Set<string>();
    resolveDispatchLaunchConfig("work", p, warned);
    resolveDispatchLaunchConfig("close", p, warned);
    expect(warned.has("work::codex")).toBe(true);
    expect(warned.has("close::codex")).toBe(true);
    expect(warned.size).toBe(2);
  });
});

describe("resolveDispatchLaunchConfig — approve resolves through work", () => {
  test("approve reads the `work` row identically to `work`", () => {
    const p = writeYaml(
      "presets.yaml",
      "dispatch:\n  work: claude::opus::xhigh\n",
    );
    expect(resolveDispatchLaunchConfig("approve", p)).toEqual(
      resolveDispatchLaunchConfig("work", p),
    );
  });

  test("approve floors identically to work when unset", () => {
    const missing = join(tmpDir, "nope.yaml");
    expect(resolveDispatchLaunchConfig("approve", missing)).toEqual(
      WORKER_FLOOR,
    );
  });
});
