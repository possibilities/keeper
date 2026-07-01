// End-to-end anchor for the read-verb output contract + the format-free/validate
// single-value paths. Read/inspection verbs emit exactly ONE top-level JSON value
// with no trailing plan_invocation line; cat stays pure markdown; validate --epic
// merges its invocation into that one value on a fresh stamp. Pinned against the
// real dispatch — the engine-agnostic equivalent of the retired Python decorator
// nodes (test_decorator_hardening.py / test_no_track_commands.py).

import { beforeEach, describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runCli, seedState, withTmpdir } from "./harness.ts";

// Last trailing plan_invocation object, or null.
function trailer(output: string): Record<string, unknown> | null {
  const line = output
    .trim()
    .split("\n")
    .reverse()
    .find((ln) => ln.trim().startsWith('{"plan_invocation"'));
  if (!line) {
    return null;
  }
  return (JSON.parse(line) as Record<string, unknown>)
    .plan_invocation as Record<string, unknown>;
}

let root: string;
const getTmp = withTmpdir("planctl-decorator-");
beforeEach(() => {
  root = getTmp();
  seedState(root, { epicId: "fn-7-real", nTasks: 1 });
});

describe("read verbs emit a single value (no invocation trailer)", () => {
  test("show emits no trailing invocation line", () => {
    // show is read-only: its payload is the whole stdout — one JSON value, with no
    // {"plan_invocation"} line riding the result stream.
    const r = runCli(["show", "fn-7-real.1"], { cwd: root });
    expect(r.code).toBe(0);
    expect(trailer(r.output)).toBeNull();
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });

  test("epics emits no trailing invocation line", () => {
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    expect(trailer(r.output)).toBeNull();
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });

  // CITED (end-to-end equivalents elsewhere in this suite — the raise-path /
  // restored-invoke nodes pin Python click instance-dict patching with no
  // engine-agnostic surface; the observable "a raised verb emits no invocation
  // line" is the typed-error path, already asserted across verbs-worker /
  // verbs-restamp where an errored verb's output carries no trailing
  // plan_invocation line):
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
    expect(r.output).not.toContain('"plan_invocation"');
  });

  test("validate --epic: ONE merged value on first stamp; ONE bare value on re-run", () => {
    const env = {
      CLAUDE_CODE_SESSION_ID: "test-no-track",
      KEEPER_PLAN_NOW: "2026-06-06T00:00:00.000000Z",
    };
    const r = runCli(["validate", "--epic", "fn-7-real"], { cwd: root, env });
    expect(r.code).toBe(0);
    const docs = parseDocStream(r.output);
    expect(docs.length).toBe(1);
    const doc1 = docs[0] as Record<string, unknown>;
    expect("valid" in doc1).toBe(true);
    expect("errors" in doc1).toBe(true);
    expect("warnings" in doc1).toBe(true);
    if (doc1.valid) {
      // The invocation is MERGED into the one value, not a second doc.
      expect("plan_invocation" in doc1).toBe(true);

      const r2 = runCli(["validate", "--epic", "fn-7-real"], {
        cwd: root,
        env,
      });
      const docs2 = parseDocStream(r2.output);
      expect(docs2.length).toBe(1);
      expect((docs2[0] as Record<string, unknown>).valid).toBe(true);
      expect("plan_invocation" in (docs2[0] as Record<string, unknown>)).toBe(
        false,
      );
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
