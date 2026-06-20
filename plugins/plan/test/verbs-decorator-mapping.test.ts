// Mapping record + end-to-end anchor for the invocation-decorator nodes —
// translated from tests/cli_decorator/test_decorator_hardening.py and
// tests/cli_decorator/test_no_track_commands.py, plus the canonical drop for
// tests/test_cli_invoker_guard.py. The Python decorator-internal nodes import
// planctl.cli's InvocationTrackedGroup / _extract_target / _TARGET_ARG_NAMES
// directly — there is no compiled-binary seam to instantiate a synthetic click
// group. Their OBSERVABLE contract (the target the decorator extracts onto the
// invocation envelope, and the no-track bypass) is pinned end-to-end here
// against the real binary, which is the engine-agnostic equivalent.

import { beforeEach, describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runCli, seedState, withTmpdir } from "./harness.ts";

// Last trailing planctl_invocation object, or null.
function trailer(output: string): Record<string, unknown> | null {
  const line = output
    .trim()
    .split("\n")
    .reverse()
    .find((ln) => ln.trim().startsWith('{"planctl_invocation"'));
  if (!line) {
    return null;
  }
  return (JSON.parse(line) as Record<string, unknown>)
    .planctl_invocation as Record<string, unknown>;
}

let root: string;
const getTmp = withTmpdir("planctl-decorator-");
beforeEach(() => {
  root = getTmp();
  seedState(root, { epicId: "fn-7-real", nTasks: 1 });
});

describe("invocation target extraction (end-to-end equivalent)", () => {
  test("a canonical id arg becomes the trailer target", () => {
    // test_decorator_hardening.py::test_extract_target_prefers_canonical_arg_name
    // test_decorator_hardening.py::test_extract_target_prefers_canonical_name_over_first_arg
    // test_decorator_hardening.py::test_target_arg_names_constant
    // The decorator lifts the canonical id arg (task_id/epic_id/id/dep_id) onto
    // the invocation; show carries a task_id positional, so target == it.
    const r = runCli(["show", "fn-7-real.1"], { cwd: root });
    expect(r.code).toBe(0);
    const t = trailer(r.output);
    expect(t).not.toBeNull();
    expect((t as Record<string, unknown>).op).toBe("show");
    expect((t as Record<string, unknown>).target).toBe("fn-7-real.1");
  });

  test("a verb with no id positional yields target null (fallback policy)", () => {
    // test_decorator_hardening.py::test_extract_target_fallback_policy_non_fn_returns_none
    // No canonical-named arg and no fn--shaped positional -> target null, never a
    // leaked arbitrary string.
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    expect((trailer(r.output) as Record<string, unknown>).target).toBeNull();
  });

  // CITED (end-to-end equivalents elsewhere in this suite — the raise-path /
  // restored-invoke nodes pin Python click instance-dict patching with no
  // engine-agnostic surface; the observable "a raised verb emits no invocation
  // line" is the typed-error path, already asserted across verbs-worker /
  // verbs-restamp where an errored verb's output carries no trailing
  // planctl_invocation line):
  //   test_decorator_hardening.py::test_raise_path_does_not_emit_invocation
  //   test_decorator_hardening.py::test_raise_path_restores_original_invoke
});

describe("no-track commands bypass the invocation decorator", () => {
  test("cat stdout is pure markdown — no trailing invocation line", () => {
    // test_no_track_commands.py::test_cat_stdout_is_pure_markdown
    const spec = readFileSync(
      join(root, ".keeper", "specs", "fn-7-real.md"),
      "utf-8",
    );
    const r = runCli(["cat", "fn-7-real"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.output).toBe(spec);
    expect(r.output).not.toContain('"planctl_invocation"');
  });

  test("validate --epic: doc1 {valid,...}, doc2 invocation on first stamp; no doc2 on re-run", () => {
    // test_no_track_commands.py::test_validate_stdout_contract
    const env = {
      CLAUDE_CODE_SESSION_ID: "test-no-track",
      PLANCTL_NOW: "2026-06-06T00:00:00.000000Z",
    };
    const r = runCli(["validate", "--epic", "fn-7-real"], { cwd: root, env });
    expect(r.code).toBe(0);
    const docs = parseDocStream(r.output);
    expect(docs.length).toBeGreaterThanOrEqual(1);
    const doc1 = docs[0] as Record<string, unknown>;
    expect("valid" in doc1).toBe(true);
    expect("errors" in doc1).toBe(true);
    expect("warnings" in doc1).toBe(true);
    if (doc1.valid) {
      expect(docs.length).toBe(2);
      expect("planctl_invocation" in (docs[1] as Record<string, unknown>)).toBe(
        true,
      );

      const r2 = runCli(["validate", "--epic", "fn-7-real"], {
        cwd: root,
        env,
      });
      const docs2 = parseDocStream(r2.output);
      expect(docs2.length).toBe(1);
      expect((docs2[0] as Record<string, unknown>).valid).toBe(true);
    }
  });
});

// DROP (test_cli_invoker_guard.py::test_no_cli_runner_outside_invoker): a
// Python-suite hygiene guard asserting no stray CliRunner() outside the
// conftest run_cli allowlist. It pins the pytest harness structure (CliRunner,
// conftest.py, the in-process engine) that the Python retirement deletes
// wholesale — there is no bun analogue to a CliRunner allowlist, so this is a
// canonical drop, not a translation.

// Parse a stream of concatenated JSON docs (compact NDJSON or pretty multi-line).
// Port of _parse_json_stream.
function parseDocStream(text: string): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) {
      i += 1;
    }
    if (i >= text.length || text[i] !== "{") {
      i += 1;
      continue;
    }
    let parsed = false;
    for (let end = text.length; end > i; end--) {
      if (text[end - 1] !== "}") {
        continue;
      }
      try {
        docs.push(JSON.parse(text.slice(i, end)) as Record<string, unknown>);
        i = end;
        parsed = true;
        break;
      } catch {
        // shrink
      }
    }
    if (!parsed) {
      break;
    }
  }
  return docs;
}
