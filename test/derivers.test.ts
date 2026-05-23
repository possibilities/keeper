/**
 * Pure-deriver tests. These exercise the parsers in `src/derivers.ts`
 * directly — no DB, no migration. The hook, the reducer, and the migration
 * backfill all share these derivers, so the same input MUST produce the same
 * output across all three call sites (re-fold determinism).
 */

import { expect, test } from "bun:test";
import { parsePlanRef } from "../src/derivers";

// ---------------------------------------------------------------------------
// parsePlanRef
// ---------------------------------------------------------------------------

test("parsePlanRef parses an epic-form ref", () => {
  expect(parsePlanRef("fn-575-osc-parser")).toEqual({
    kind: "epic",
    epic_id: "fn-575-osc-parser",
  });
});

test("parsePlanRef parses a task-form ref into epic_id + task_id", () => {
  expect(parsePlanRef("fn-575-osc-parser.3")).toEqual({
    kind: "task",
    epic_id: "fn-575-osc-parser",
    task_id: "fn-575-osc-parser.3",
  });
});

test("parsePlanRef parses a multi-digit task ordinal", () => {
  expect(parsePlanRef("fn-1-foo.42")).toEqual({
    kind: "task",
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.42",
  });
});

test("parsePlanRef returns null on a trailing dot with no ordinal", () => {
  // `fn-1-foo.` — the optional dot-group requires `\d+` after the dot.
  expect(parsePlanRef("fn-1-foo.")).toBeNull();
});

test("parsePlanRef returns null on a ref with no slug body", () => {
  // `fn-1` — requires the kebab body after the number.
  expect(parsePlanRef("fn-1")).toBeNull();
});

test("parsePlanRef returns null on a malformed shape (consecutive dashes)", () => {
  // `fn--foo` — `\d+` must match between the `fn-` and the next `-`.
  expect(parsePlanRef("fn--foo")).toBeNull();
});

test("parsePlanRef returns null on the empty string", () => {
  expect(parsePlanRef("")).toBeNull();
});

test("parsePlanRef returns null on null input (defensive)", () => {
  expect(parsePlanRef(null)).toBeNull();
});

test("parsePlanRef rejects uppercase letters in the slug body", () => {
  expect(parsePlanRef("fn-1-FOO")).toBeNull();
  expect(parsePlanRef("fn-1-foo.3X")).toBeNull();
});

test("parsePlanRef rejects trailing whitespace", () => {
  expect(parsePlanRef("fn-1-foo ")).toBeNull();
  expect(parsePlanRef("fn-1-foo.3 ")).toBeNull();
});

test("parsePlanRef rejects extra dot-segments past the ordinal", () => {
  // `fn-1-foo.3.4` — the `$` anchor stops at the ordinal.
  expect(parsePlanRef("fn-1-foo.3.4")).toBeNull();
});

test("parsePlanRef rejects leading slash", () => {
  expect(parsePlanRef("/fn-1-foo")).toBeNull();
});

test("parsePlanRef accepts numeric slug bodies", () => {
  // The slug class is `[a-z0-9-]+` — pure digits are valid (e.g. `fn-1-2`).
  expect(parsePlanRef("fn-1-2")).toEqual({
    kind: "epic",
    epic_id: "fn-1-2",
  });
});
