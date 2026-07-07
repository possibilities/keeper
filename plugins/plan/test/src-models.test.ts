// Unit tests for src/models.ts — the normalize/merge spine. mergeTaskState's
// absent-runtime default (status "todo") is the contract status/epics counting
// relies on; normalizeEpic/normalizeTask pin the optional-field defaults.

import { describe, expect, test } from "bun:test";

import { mergeTaskState, normalizeEpic, normalizeTask } from "../src/models.ts";

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
