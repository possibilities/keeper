/**
 * Unit tests for the dep-free `src/glob.ts` fnmatch leaf: `isGlobToken`
 * detection and `compileFnmatch` semantics (anchored `*`/`?` mapping, `:` as a
 * non-separator, consecutive-`*` collapse, never-throws). The leaf enters the
 * hook import graph through `reducer.ts`, so its behavior is contract-pinned
 * here independently of either consumer.
 */
import { expect, test } from "bun:test";
import { compileFnmatch, isGlobToken } from "../src/glob";

test("isGlobToken: true only for `*` / `?`", () => {
  expect(isGlobToken("panels:*")).toBe(true);
  expect(isGlobToken("a?b")).toBe(true);
  expect(isGlobToken("plain-name")).toBe(false);
  expect(isGlobToken("panels:foo")).toBe(false);
  expect(isGlobToken("")).toBe(false);
});

test("compileFnmatch: a glob-free token is an exact anchored match", () => {
  const re = compileFnmatch("pair");
  expect(re.test("pair")).toBe(true);
  expect(re.test("pairs")).toBe(false);
  expect(re.test("xpair")).toBe(false);
  expect(re.test("pa")).toBe(false);
});

test("compileFnmatch: `*` matches a run of non-separator chars", () => {
  const re = compileFnmatch("panels:*");
  expect(re.test("panels:foo")).toBe(true);
  expect(re.test("panels:foo-bar_7")).toBe(true);
  expect(re.test("panels:")).toBe(true);
  // `:` is NOT a separator, but the literal colon must be present.
  expect(re.test("panelsfoo")).toBe(false);
  expect(re.test("panels")).toBe(false);
  // `*` → `[^/]*` does NOT cross a path separator.
  expect(re.test("panels:a/b")).toBe(false);
});

test("compileFnmatch: `?` matches exactly one non-separator char", () => {
  const re = compileFnmatch("a?c");
  expect(re.test("abc")).toBe(true);
  expect(re.test("a-c")).toBe(true);
  expect(re.test("ac")).toBe(false);
  expect(re.test("abbc")).toBe(false);
  expect(re.test("a/c")).toBe(false);
});

test("compileFnmatch: regex metacharacters are escaped (literal match)", () => {
  const re = compileFnmatch("a.b+(c)*");
  expect(re.test("a.b+(c)")).toBe(true);
  expect(re.test("a.b+(c)-tail")).toBe(true);
  // `.` is literal, not "any char".
  expect(re.test("aXb+(c)")).toBe(false);
});

test("compileFnmatch: consecutive `*` collapse (same language, ReDoS-safe)", () => {
  const re = compileFnmatch("x***y");
  expect(re.test("xy")).toBe(true);
  expect(re.test("xMIDDLEy")).toBe(true);
  expect(re.test("x_y")).toBe(true);
  // Collapsed to a single `[^/]*` — no adjacent `[^/]*[^/]*` backtracking shape.
  expect(re.source).toBe("^x[^/]*y$");
});

test("compileFnmatch: returns a cached identical RegExp for the same token", () => {
  expect(compileFnmatch("panels:*")).toBe(compileFnmatch("panels:*"));
});

test("compileFnmatch: never throws on garbage input", () => {
  for (const garbage of ["", "*", "?", "[", "](){}^$|\\", "***?***", "\\"]) {
    expect(() => compileFnmatch(garbage)).not.toThrow();
  }
});
