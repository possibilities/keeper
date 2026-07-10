// Unit tests for src/models.ts — the normalize/merge spine. mergeTaskState's
// absent-runtime default (status "todo") is the contract status/epics counting
// relies on; normalizeEpic/normalizeTask pin the optional-field defaults.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configuredModels,
  mergeTaskState,
  normalizeEpic,
  normalizeTask,
  workerAgentFor,
} from "../src/models.ts";

describe("mergeTaskState", () => {
  test("absent runtime defaults to status todo", () => {
    expect(mergeTaskState({ id: "fn-1-x.1" }, null).status).toBe("todo");
  });

  test("runtime status overlays the definition", () => {
    const merged = mergeTaskState(
      { id: "fn-1-x.1", status: "todo" },
      {
        status: "done",
      },
    );
    expect(merged.status).toBe("done");
  });
});

describe("normalizeTask", () => {
  test("applies optional-field defaults", () => {
    const t = normalizeTask({ id: "fn-1-x.1" });
    expect(t.priority).toBeNull();
    expect(t.depends_on).toEqual([]);
    expect(t.tier).toBeNull();
    expect(t.model).toBeNull();
    expect(t.audit_required).toBe(false);
    expect(t.snippets).toEqual([]);
    expect(t.bundles).toEqual([]);
  });

  test("legacy model-less task folds to model: null, never throws", () => {
    // A record minted before the model axis existed carries no `model` key;
    // normalize must default it (mirror of the tier: null legacy default) so a
    // fold over legacy state never throws.
    const legacy = normalizeTask({ id: "fn-1-x.1", tier: "medium" });
    expect(legacy.model).toBeNull();
    expect(legacy.tier).toBe("medium");
  });

  test("preserves an existing model", () => {
    expect(normalizeTask({ id: "fn-1-x.1", model: "opus" }).model).toBe("opus");
  });

  test("depends_on falls back to deps when present", () => {
    expect(normalizeTask({ deps: ["fn-1-x.1"] }).depends_on).toEqual([
      "fn-1-x.1",
    ]);
  });
});

describe("normalizeEpic", () => {
  test("defaults branch_name and scrubs dead keys", () => {
    const e = normalizeEpic({ id: "fn-1-x", draft: true });
    expect(e.branch_name).toBe("main");
    expect("draft" in e).toBe(false);
    expect("queue_jump" in e).toBe(false);
    expect(e.last_validated_at).toBeNull();
  });
});

// models.ts's configured-axes seam reads the composed EFFECTIVE matrix (host
// provider matrix when present, embedded snapshot when absent). Fixtures inject a
// host matrix via KEEPER_CONFIG_DIR; the no-matrix case points at an empty config
// dir so the embedded fallback holds regardless of the developer's host.
describe("configured-axes read the effective matrix", () => {
  function withConfigDir<T>(dir: string, fn: () => T): T {
    const prev = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = dir;
    try {
      return fn();
    } finally {
      if (prev === undefined) {
        delete process.env.KEEPER_CONFIG_DIR;
      } else {
        process.env.KEEPER_CONFIG_DIR = prev;
      }
    }
  }

  test("a host matrix grows the model axis; workerAgentFor composes the host cell", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-eff-"));
    try {
      writeFileSync(
        join(dir, "matrix.yaml"),
        [
          "efforts: [medium, high]",
          "providers:",
          "  - name: claude",
          "    models: [opus]",
          "  - name: codex",
          "    models:",
          "      - name: gpt-5.5",
          "        native: openai/gpt-5.5",
          "subagents: [work]",
          "wrapper_driver:",
          "  model: sonnet",
          "  effort: high",
          "",
        ].join("\n"),
      );
      withConfigDir(dir, () => {
        expect(configuredModels()).toEqual(["opus", "gpt-5.5"]);
        expect(workerAgentFor("high", "gpt-5.5")).toBe(
          "plan:worker-gpt-5.5-high",
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no host matrix falls back to the embedded axes (null-stop preserved)", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-eff-none-"));
    try {
      withConfigDir(dir, () => {
        expect(configuredModels()).toEqual(["opus", "sonnet"]);
        expect(workerAgentFor("medium", "opus")).toBe(
          "plan:worker-opus-medium",
        );
        expect(workerAgentFor(null, "opus")).toBeNull();
        expect(() => workerAgentFor("high", "gpt-5.5")).toThrow(
          /unknown model/,
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
