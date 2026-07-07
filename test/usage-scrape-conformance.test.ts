import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CaseMeta, deriveContract } from "./helpers/conformance-derive";

/**
 * In-process parse conformance over the frozen corpus screens.
 *
 * Feeds every case's committed `screen.txt` through the parsers via the same
 * arm-branching the live CLI uses and deep-compares the result against the
 * committed `expected.json` — tmux-free, subprocess-free, so it runs in plain
 * `bun test` and stays clear of Bun#24690 (empty subprocess pipes under the test
 * runner). This is the parser-drift gate: it fails the moment a parser change
 * diverges from the frozen contract.
 */

const CORPUS_DIR = join(import.meta.dir, "fixtures", "corpus");

interface Case {
  name: string;
  meta: CaseMeta;
  screen: string;
  expected: unknown;
}

function loadCases(): Case[] {
  const cases: Case[] = [];
  for (const name of readdirSync(CORPUS_DIR).sort()) {
    const dir = join(CORPUS_DIR, name);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    const meta = JSON.parse(
      readFileSync(join(dir, "case.json"), "utf8"),
    ) as CaseMeta;
    const screen = readFileSync(join(dir, "screen.txt"), "utf8");
    const expected = JSON.parse(
      readFileSync(join(dir, "expected.json"), "utf8"),
    );
    cases.push({ name, meta, screen, expected });
  }
  return cases;
}

const CASES = loadCases();

describe("parse conformance over frozen corpus screens", () => {
  // Guard against a silent discovery regression making the suite vacuous: the
  // corpus carries 14 committed cases.
  test("discovers the committed corpus", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(14);
  });

  for (const c of CASES) {
    test(`${c.name}: screen.txt re-derives expected.json`, async () => {
      const { payload, exitCode } = await deriveContract(c.meta, c.screen);
      expect(payload).toEqual(c.expected as Record<string, unknown>);
      expect(exitCode).toBe(c.meta.expected_exit_code);
    });
  }
});
