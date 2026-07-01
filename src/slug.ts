/**
 * Pure slug identity primitives — an agent-authored, slugified `[a-z0-9-]+`
 * identifier. This is a DEP-FREE leaf (no `bun:sqlite`, no DB, no other keeper
 * module): the handoff path (`src/handoff-slug.ts`, which layers a host-global
 * uniqueness probe on top) and the panel path (`src/pair/panel.ts`, which MUST
 * stay `bun:sqlite`-free) both import from here.
 *
 * Two helpers: {@link slugify} (CLI-side normalization of free text → slug|null)
 * and {@link validateSlug} (a socket-boundary re-validation — a hand-crafted RPC
 * bypasses the CLI). {@link validateSlug}'s `label` names the identifier in its
 * error strings, so each caller keeps its own wording ("handoff slug…", "slug…").
 */

/** Max slug length (chars) AFTER slugify. A slug rides as a tmux/spawn name and
 *  inline in the event log, so it stays short. The CLI truncates to this; a
 *  validator rejects anything longer. */
export const SLUG_MAX_LEN = 64;

/**
 * Normalize free text to a `[a-z0-9-]+` slug, or `null` when the result is empty
 * (the CLI rejects that as misuse — slugs are user-authored, never suffixed).
 * Reimplements the shape of `plugins/plan/src/ids.ts:slugify` WITHOUT importing
 * the peer plan plugin: NFKD → strip combining marks (`\p{M}`) → drop remaining
 * non-ASCII (homoglyphs fall out of the ASCII class) → lowercase → collapse every
 * run of non-`[a-z0-9]` to a single `-` → trim leading/trailing `-` → cap length
 * AFTER the transform. `.`/`..`/all-dash/emoji-only inputs all collapse to empty
 * and return `null`.
 */
export function slugify(text: string): string | null {
  let s = String(text).normalize("NFKD");
  // Strip combining marks the NFKD decomposition exposed (é → e + ´).
  s = s.replace(/\p{M}/gu, "");
  // Drop anything still outside ASCII (emoji, CJK, homoglyphs).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-only gate.
  s = s.replace(/[^\x00-\x7F]/g, "");
  s = s.toLowerCase();
  // Every run of non-alphanumerics collapses to a single hyphen.
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX_LEN) {
    s = s.slice(0, SLUG_MAX_LEN).replace(/-+$/g, "");
  }
  return s === "" ? null : s;
}

/** Discriminated result of {@link validateSlug}. */
export type ValidateSlugResult = { ok: true } | { ok: false; error: string };

/**
 * Re-validate a slug at a trust boundary. The CLI slugifies, but a hand-crafted
 * RPC bypasses that, so a validator independently rejects empty / oversized /
 * `.` / `..` / non-`[a-z0-9-]+` / all-hyphen values. `label` names the identifier
 * in the error strings so a caller keeps its own wording. Pure.
 */
export function validateSlug(
  slug: unknown,
  label = "slug",
): ValidateSlugResult {
  if (typeof slug !== "string" || slug.length === 0) {
    return { ok: false, error: `${label} is empty` };
  }
  if (slug === "." || slug === "..") {
    return { ok: false, error: `${label} cannot be '.' or '..'` };
  }
  if (slug.length > SLUG_MAX_LEN) {
    return {
      ok: false,
      error: `${label} is ${slug.length} chars, over the ${SLUG_MAX_LEN}-char cap`,
    };
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return {
      ok: false,
      error: `${label} must match [a-z0-9-]+ (lowercase letters, digits, hyphens)`,
    };
  }
  if (!/[a-z0-9]/.test(slug)) {
    return {
      ok: false,
      error: `${label} must contain at least one letter or digit`,
    };
  }
  return { ok: true };
}
