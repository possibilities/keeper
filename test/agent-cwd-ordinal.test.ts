/**
 * cwd-ordinal counter: monotonic per-cwd-basename increment under a flock held
 * on the data file directly (non-truncating open via agentusage's raw flock
 * exports), with fail-open on a corrupt file. The counter path is fixed under
 * ~/.local/state/agentwrap, so these run against the real state dir and clean up
 * the keys they touch (unique basenames keep them isolated).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nextCwdOrdinal } from "../src/agent/cwd-ordinal";

const counterPath = join(
  homedir(),
  ".local",
  "state",
  "agentwrap",
  "cwd-ordinals.json",
);

const touchedKeys: string[] = [];

function uniqueKey(): string {
  const k = `agentwrap-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  touchedKeys.push(k);
  return k;
}

afterEach(() => {
  // Remove only the keys this suite created — never clobber a real counter.
  if (!existsSync(counterPath)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(counterPath, "utf8")) as Record<
      string,
      unknown
    >;
    let changed = false;
    for (const k of touchedKeys) {
      if (k in data) {
        delete data[k];
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(counterPath, `${JSON.stringify(data, null, 2)}\n`);
    }
  } catch {
    // best-effort cleanup
  }
});

describe("nextCwdOrdinal", () => {
  test("first call returns 1, then increments monotonically", () => {
    const key = uniqueKey();
    expect(nextCwdOrdinal(key)).toBe(1);
    expect(nextCwdOrdinal(key)).toBe(2);
    expect(nextCwdOrdinal(key)).toBe(3);
  });

  test("distinct keys are independent", () => {
    const a = uniqueKey();
    const b = uniqueKey();
    expect(nextCwdOrdinal(a)).toBe(1);
    expect(nextCwdOrdinal(b)).toBe(1);
    expect(nextCwdOrdinal(a)).toBe(2);
  });

  test("existing content survives (non-truncating open)", () => {
    const a = uniqueKey();
    const b = uniqueKey();
    nextCwdOrdinal(a); // a = 1
    nextCwdOrdinal(b); // b = 1
    nextCwdOrdinal(a); // a = 2
    // b's counter must be intact despite a's rewrites.
    expect(nextCwdOrdinal(b)).toBe(2);
  });
});
