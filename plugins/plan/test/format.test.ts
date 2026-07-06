// Tests for the `--format json|yaml|human` grammar on the plan CLI. yaml renders
// through the shared PyYAML-parity serializer (yamlDump); the byte-parity
// human→JSON fallback for a renderer-less verb is preserved; the frozen validate
// envelope rejects yaml as an unsupported mode (exit 2), never rendering it.

import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";

import { formatOutput, jsonDumps, yamlDumps } from "../src/format.ts";
import { runCli, seedState, withTmpdir } from "./harness.ts";

/** Capture process.stdout.write around a synchronous emit. */
function capture(fn: () => void): string {
  const prior = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: unknown): boolean => {
    out +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = prior;
  }
  return out;
}

describe("yamlDumps", () => {
  test("block mapping, one trailing newline, insertion order (no key sort)", () => {
    // Independent expected: hand-written YAML, not re-derived from the serializer.
    expect(yamlDumps({ success: true, epics: [], total: 0 })).toBe(
      "success: true\nepics: []\ntotal: 0\n",
    );
  });

  test("preserves declared key order rather than sorting", () => {
    expect(yamlDumps({ b: 1, a: 2 })).toBe("b: 1\na: 2\n");
  });

  test("round-trips a nested unicode envelope back to the same value (yq parity)", () => {
    const value = { success: false, error: { code: "X", message: "Café ☕" } };
    expect(yaml.load(yamlDumps(value))).toEqual(value);
  });
});

describe("formatOutput format routing", () => {
  const data = { success: true, count: 1 };

  test("--format yaml renders through the shared serializer", () => {
    expect(capture(() => formatOutput(data, "yaml"))).toBe(
      "success: true\ncount: 1\n",
    );
    expect(capture(() => formatOutput(data, "yaml"))).toBe(yamlDumps(data));
  });

  test("--format json renders pretty JSON", () => {
    expect(capture(() => formatOutput(data, "json"))).toBe(jsonDumps(data));
  });

  test("--format human with no renderer falls back to JSON bytes (byte-parity)", () => {
    expect(capture(() => formatOutput(data, "human"))).toBe(jsonDumps(data));
  });

  test("--format human with a renderer renders human text", () => {
    expect(capture(() => formatOutput(data, "human", () => "HUMAN ROW"))).toBe(
      "HUMAN ROW\n",
    );
  });
});

describe("plan CLI --format yaml end to end", () => {
  const tmp = withTmpdir();

  test("a read verb's YAML output round-trips to its JSON value", () => {
    const root = tmp();
    seedState(root, {
      epicId: "fn-1-cafe",
      title: "Café résumé ☕",
      nTasks: 2,
    });
    const yamlOut = runCli(["--format", "yaml", "epics"], { cwd: root });
    const jsonOut = runCli(["epics"], { cwd: root });
    expect(yamlOut.code).toBe(0);
    expect(jsonOut.code).toBe(0);
    // The yaml serialization decodes to exactly the json envelope value.
    expect(yaml.load(yamlOut.stdout)).toEqual(JSON.parse(jsonOut.stdout));
    // And it is genuinely YAML, not the JSON bytes.
    expect(yamlOut.stdout).not.toBe(jsonOut.stdout);
  });

  test("validate rejects --format yaml as a usage fault (exit 2), never rendering yaml", () => {
    const root = tmp();
    const r = runCli(["--format", "yaml", "validate"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--format");
  });
});
