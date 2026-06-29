/**
 * `src/handoff-slug.ts` pure-helper tests: slugify normalization + edge cases,
 * the daemon's socket-boundary slug re-validation, and the host-global
 * uniqueness probe (seed a `HandoffRequested` event, assert exists for that slug,
 * absent for another). All in-process over `freshMemDb` — no daemon boot.
 */

import { expect, test } from "bun:test";
import {
  HANDOFF_SLUG_MAX_LEN,
  handoffSlugExists,
  slugifyHandoffSlug,
  validateHandoffSlug,
} from "../src/handoff-slug";
import { freshMemDb } from "./helpers/template-db";

test("slugifyHandoffSlug: lowercases and hyphenates ordinary text", () => {
  expect(slugifyHandoffSlug("Investigate Foo")).toBe("investigate-foo");
  expect(slugifyHandoffSlug("clean up the X queue!")).toBe(
    "clean-up-the-x-queue",
  );
});

test("slugifyHandoffSlug: collapses runs and trims edge punctuation", () => {
  expect(slugifyHandoffSlug("  --foo___bar--  ")).toBe("foo-bar");
  expect(slugifyHandoffSlug("a...b   c")).toBe("a-b-c");
});

test("slugifyHandoffSlug: strips accents via NFKD, keeps the ASCII base", () => {
  expect(slugifyHandoffSlug("café déjà")).toBe("cafe-deja");
});

test("slugifyHandoffSlug: an already-valid slug round-trips unchanged", () => {
  expect(slugifyHandoffSlug("investigate-foo")).toBe("investigate-foo");
  expect(slugifyHandoffSlug("3-leading-digit")).toBe("3-leading-digit");
});

test("slugifyHandoffSlug: empty-after-transform inputs return null", () => {
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
    expect(slugifyHandoffSlug(bad)).toBeNull();
  }
});

test("slugifyHandoffSlug: caps length AFTER transform and trims a trailing hyphen", () => {
  const long = "a".repeat(HANDOFF_SLUG_MAX_LEN + 20);
  const out = slugifyHandoffSlug(long);
  expect(out).not.toBeNull();
  expect((out as string).length).toBe(HANDOFF_SLUG_MAX_LEN);
  // A cut that lands on a hyphen is trimmed (no trailing dash).
  const withDash = `${"a".repeat(HANDOFF_SLUG_MAX_LEN)}-tail`;
  const trimmed = slugifyHandoffSlug(withDash) as string;
  expect(trimmed.endsWith("-")).toBe(false);
});

test("validateHandoffSlug: accepts a well-formed slug", () => {
  expect(validateHandoffSlug("investigate-foo")).toEqual({ ok: true });
  expect(validateHandoffSlug("3-foo")).toEqual({ ok: true });
});

test("validateHandoffSlug: rejects empty / `.` / `..` / non-class / all-hyphen / oversized", () => {
  for (const bad of [
    "",
    ".",
    "..",
    "Has-Caps",
    "has_underscore",
    "has space",
    "has.dot",
    "---",
    "a".repeat(HANDOFF_SLUG_MAX_LEN + 1),
  ]) {
    const r = validateHandoffSlug(bad);
    expect(r.ok).toBe(false);
  }
});

test("validateHandoffSlug: rejects a non-string (hand-crafted RPC bypass)", () => {
  for (const bad of [null, undefined, 1, true, [], {}]) {
    expect(validateHandoffSlug(bad).ok).toBe(false);
  }
});

test("handoffSlugExists: true for a seeded HandoffRequested slug, false otherwise", () => {
  const { db } = freshMemDb();
  db.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type) VALUES (?, ?, 'HandoffRequested', 'handoffs')",
    [1, "investigate-foo"],
  );
  expect(handoffSlugExists("investigate-foo", db)).toBe(true);
  expect(handoffSlugExists("some-other-slug", db)).toBe(false);
});

test("handoffSlugExists: a same-session_id row of a DIFFERENT hook_event does not count", () => {
  const { db } = freshMemDb();
  // A non-handoff event whose session_id collides with a slug must NOT register.
  db.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type) VALUES (?, ?, 'SessionStart', 'session_start')",
    [1, "investigate-foo"],
  );
  expect(handoffSlugExists("investigate-foo", db)).toBe(false);
});
