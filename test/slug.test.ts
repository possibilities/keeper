/**
 * `src/slug.ts` pure-helper tests: slugify normalization + edge cases and the
 * trust-boundary re-validation (empty / `.` / `..` / non-class / all-hyphen /
 * oversized / non-string), plus the `label` wording knob. Dep-free — no DB, no
 * daemon boot (the host-global uniqueness probe is the handoff-scoped sibling in
 * test/handoff-slug.test.ts).
 */

import { expect, test } from "bun:test";
import { SLUG_MAX_LEN, slugify, validateSlug } from "../src/slug";

test("slugify: lowercases and hyphenates ordinary text", () => {
  expect(slugify("Investigate Foo")).toBe("investigate-foo");
  expect(slugify("clean up the X queue!")).toBe("clean-up-the-x-queue");
});

test("slugify: collapses runs and trims edge punctuation", () => {
  expect(slugify("  --foo___bar--  ")).toBe("foo-bar");
  expect(slugify("a...b   c")).toBe("a-b-c");
});

test("slugify: strips accents via NFKD, keeps the ASCII base", () => {
  expect(slugify("café déjà")).toBe("cafe-deja");
});

test("slugify: an already-valid slug round-trips unchanged", () => {
  expect(slugify("investigate-foo")).toBe("investigate-foo");
  expect(slugify("3-leading-digit")).toBe("3-leading-digit");
});

test("slugify: empty-after-transform inputs return null", () => {
  for (const bad of [
    "",
    "   ",
    "...",
    "..",
    ".",
    "---",
    "!!!",
    "😀😀",
    "日本語",
  ]) {
    expect(slugify(bad)).toBeNull();
  }
});

test("slugify: caps length AFTER transform and trims a trailing hyphen", () => {
  const long = "a".repeat(SLUG_MAX_LEN + 20);
  const out = slugify(long);
  expect(out).not.toBeNull();
  expect((out as string).length).toBe(SLUG_MAX_LEN);
  // A cut that lands on a hyphen is trimmed (no trailing dash).
  const withDash = `${"a".repeat(SLUG_MAX_LEN)}-tail`;
  const trimmed = slugify(withDash) as string;
  expect(trimmed.endsWith("-")).toBe(false);
});

test("validateSlug: accepts a well-formed slug", () => {
  expect(validateSlug("investigate-foo")).toEqual({ ok: true });
  expect(validateSlug("3-foo")).toEqual({ ok: true });
});

test("validateSlug: rejects empty / `.` / `..` / non-class / all-hyphen / oversized", () => {
  for (const bad of [
    "",
    ".",
    "..",
    "Has-Caps",
    "has_underscore",
    "has space",
    "has.dot",
    "---",
    "a".repeat(SLUG_MAX_LEN + 1),
  ]) {
    expect(validateSlug(bad).ok).toBe(false);
  }
});

test("validateSlug: rejects a non-string (hand-crafted RPC bypass)", () => {
  for (const bad of [null, undefined, 1, true, [], {}]) {
    expect(validateSlug(bad).ok).toBe(false);
  }
});

test("validateSlug: the label names the identifier in error strings", () => {
  const generic = validateSlug("", "slug");
  expect(generic.ok).toBe(false);
  if (!generic.ok) expect(generic.error).toBe("slug is empty");

  const handoff = validateSlug("Has-Caps", "handoff slug");
  expect(handoff.ok).toBe(false);
  if (!handoff.ok) expect(handoff.error).toContain("handoff slug must match");

  // The default label is the generic "slug".
  const dflt = validateSlug("..");
  expect(dflt.ok).toBe(false);
  if (!dflt.ok) expect(dflt.error).toBe("slug cannot be '.' or '..'");
});
