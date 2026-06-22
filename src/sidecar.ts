/**
 * Dep-free helpers for the `~/docs` metadata sidecar (fn-884).
 *
 * Two consumers share this module, so the strip-signature detector and the
 * sidecar read/merge/serialize logic live here ONCE (no regex drift):
 *  - the keeper sidecar-writer hook (`plugins/keeper/plugin/hooks/sidecar-writer.ts`)
 *    create-or-merges a doc's `.yaml` sidecar on Write and upserts the gist URL
 *    on `gh gist create`;
 *  - the one-shot migration (fn-884 `.4`) strips the machine-stamped
 *    `## Metadata` trailer out of every existing `~/docs/*.md` body using the
 *    SAME {@link stripDocSignature} detector.
 *
 * IMPORTS ARE LIMITED TO `node:fs`/`node:os`/`node:path`. This module is pulled
 * into a Claude Code hook, so it inherits the hook's cold-start budget: NO
 * `bun:sqlite`, NO `src/db.ts`, NO third-party deps. Keep it that way.
 *
 * The on-disk sidecar is a flat single-level YAML map of string scalars (the
 * fields this writer emits). We hand-roll a minimal parser + serializer rather
 * than pull a YAML dep — the value set is small and fully under our control.
 * NESTED structures an existing hand-written sidecar may carry (`reviewers:`,
 * `sources_*:` lists) are NOT modelled as scalars: {@link parseSidecarText}
 * preserves them verbatim as a passthrough tail so a merge never drops them.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A bounded gist-URL matcher. The old arthack regex (`https:\/\/gist...\/\S+`)
 * was greedy across the JSON tail of a tool-response and corrupted 4 docs by
 * swallowing trailing `","stderr":"..."}` into the captured URL. `[^\s"'<>]+`
 * stops at the first whitespace OR JSON/HTML delimiter, so the capture is the
 * bare URL with nothing trailing.
 */
export const GIST_URL_RE = /https?:\/\/gist\.github\.com\/[^\s"'<>]+/;

/**
 * Pull the first gist URL out of arbitrary text (a tool-response stdout/stderr
 * blob). Returns null when no bounded match is present.
 */
export function extractGistUrl(text: string): string | null {
  const m = text.match(GIST_URL_RE);
  return m ? m[0] : null;
}

/**
 * The machine-stamped trailer the legacy arthack hook appended to every
 * `~/docs/*.md`. Shape (verbatim):
 *
 *   \n---\n\n## Metadata\n\n```yaml\n<fields>\n```\n\n```sh\n<resume>\n```\n
 *
 * The signature we anchor on is the `## Metadata` heading whose following
 * ```yaml fence carries a `session-id:` (or `path:`) line — the machine block,
 * never a doc author's own "Metadata" heading. We take the LAST such heading
 * (the stamp is always appended at EOF; 8 of 207 stamped docs ALSO carry an
 * author "## Metadata" earlier in the body, which must survive).
 */
const META_HEADING = /^## Metadata$/gm;

/**
 * Strip the machine-stamped `## Metadata` trailer from a doc body. Returns the
 * body unchanged when no machine stamp is present (idempotent — safe to run on
 * an already-migrated or never-stamped doc). NEVER throws.
 *
 * Conservative by construction: it only strips a `## Metadata` block confirmed
 * to be a machine stamp (its ```yaml fence contains `session-id:` and a `path:`
 * line) and only the LAST one, then trims back over a preceding `---` thematic
 * break and surrounding blank lines so the stripped body has no dangling
 * separator. Anything that doesn't match the exact machine shape is left alone.
 */
export function stripDocSignature(body: string): string {
  // Find the LAST `## Metadata` heading. The regex is `g`-flagged so successive
  // `exec` calls advance `lastIndex` (a non-global regex would re-match index 0
  // forever — an infinite loop). Reset `lastIndex` before AND after so the
  // shared regex object is reentrant.
  META_HEADING.lastIndex = 0;
  let lastIdx = -1;
  for (
    let m = META_HEADING.exec(body);
    m !== null;
    m = META_HEADING.exec(body)
  ) {
    lastIdx = m.index;
  }
  META_HEADING.lastIndex = 0;
  if (lastIdx === -1) {
    return body;
  }

  // Everything from the heading to EOF is the candidate trailer.
  const trailer = body.slice(lastIdx);
  // Confirm it is the machine stamp: a ```yaml fence carrying both a
  // `session-id:` and a `path:` line. A doc-author "Metadata" heading won't.
  const yamlStart = trailer.indexOf("```yaml");
  if (yamlStart === -1) {
    return body;
  }
  const yamlEnd = trailer.indexOf("```", yamlStart + "```yaml".length);
  if (yamlEnd === -1) {
    return body;
  }
  const fence = trailer.slice(yamlStart, yamlEnd);
  if (!/^session-id:/m.test(fence) || !/^path:/m.test(fence)) {
    return body;
  }

  // Trim back over a preceding `---` thematic break + blank lines so the
  // stripped body ends cleanly. Walk backwards from the heading.
  let cut = lastIdx;
  // back over the blank line(s) immediately before the heading
  const head = body.slice(0, cut);
  // Match an optional trailing `\n---\n` (with surrounding blank lines) right
  // before the heading; drop it too.
  const sepMatch = head.match(/\n+(?:---\s*\n)?\s*$/);
  if (sepMatch) {
    cut = sepMatch.index ?? cut;
  }
  return `${body.slice(0, cut).replace(/\s+$/, "")}\n`;
}

/**
 * Parsed sidecar: the leading flat scalar map (insertion-order-preserving) plus
 * a verbatim `tail` carrying any structure we don't model as a scalar (nested
 * lists like `reviewers:` / `sources_*:`). A merge edits `fields` and re-emits
 * `tail` untouched, so a hand-written sidecar's rich structure survives.
 */
export interface ParsedSidecar {
  /** Ordered top-level `key: value` scalar pairs. */
  fields: Map<string, string>;
  /** Verbatim remainder (first non-scalar line onward), or "". */
  tail: string;
}

/**
 * Parse a sidecar's text into {@link ParsedSidecar}. A line is a modelled
 * scalar iff it matches `^<key>: <value>$` at column 0 (no leading indent) AND
 * we have not yet hit a non-scalar line. The FIRST line that is indented, blank
 * mid-stream, a list item, or a bare `key:` with no value flips us into
 * passthrough: that line and everything after it is captured verbatim as
 * `tail`. NEVER throws.
 */
export function parseSidecarText(text: string): ParsedSidecar {
  const fields = new Map<string, string>();
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length === 0) {
      // A trailing blank line is just the file's final newline; keep scanning
      // only if every remaining line is blank (pure padding), else passthrough.
      if (lines.slice(i).every((l) => l.length === 0)) {
        i = lines.length;
        break;
      }
      break;
    }
    const m = line.match(/^([A-Za-z0-9_-]+): (.*)$/);
    if (!m) {
      break;
    }
    fields.set(m[1] as string, unquoteScalar(m[2] as string));
  }
  const tail = i < lines.length ? lines.slice(i).join("\n") : "";
  return { fields, tail };
}

/**
 * Unquote a YAML scalar produced by {@link quoteScalar}: a single-quoted string
 * (with `''` → `'` unescaping) or a double-quoted string, else verbatim. Only
 * the two quote styles this serializer emits are recognized.
 */
function unquoteScalar(raw: string): string {
  const v = raw.trimEnd();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Serialize a scalar value for the sidecar. A value emits BARE only when it is a
 * safe plain scalar — a run of word/path chars (`A-Za-z0-9_./+-`) with no space,
 * no YAML-special char, and no shell metacharacter. Everything else (anything
 * with a space, `:`, `&`, quotes, `#`, …) is single-quoted with `'` → `''`
 * escaping. Single-quote style avoids backslash-escape ambiguity entirely, and
 * the conservative allow-list keeps a real YAML reader from mis-parsing a value
 * like `cd /x && claude --resume z`.
 */
const SAFE_PLAIN_SCALAR = /^[A-Za-z0-9_./+-]+$/;

export function quoteScalar(value: string): string {
  if (value.length > 0 && SAFE_PLAIN_SCALAR.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Serialize a {@link ParsedSidecar} back to text (trailing newline). Scalars
 * first in their map order, then the verbatim tail.
 */
export function serializeSidecar(sidecar: ParsedSidecar): string {
  const out: string[] = [];
  for (const [k, v] of sidecar.fields) {
    out.push(`${k}: ${quoteScalar(v)}`);
  }
  let text = out.join("\n");
  if (sidecar.tail.length > 0) {
    text += (text.length > 0 ? "\n" : "") + sidecar.tail;
  }
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  return text;
}

/**
 * Merge incoming scalar fields into an existing parsed sidecar IN PLACE-ish
 * (returns a new ParsedSidecar). Existing values WIN for the preserve-set
 * (`created` — the original creation stamp must never be overwritten on a
 * re-Write); every other incoming field overwrites. A field present in the
 * existing sidecar but absent from `incoming` is kept. Insertion order: the
 * existing order is preserved; brand-new keys append in `incoming` order.
 */
const PRESERVE_KEYS = new Set(["created"]);

export function mergeSidecarFields(
  existing: ParsedSidecar,
  incoming: Map<string, string>,
): ParsedSidecar {
  const fields = new Map(existing.fields);
  for (const [k, v] of incoming) {
    if (PRESERVE_KEYS.has(k) && fields.has(k)) {
      continue;
    }
    fields.set(k, v);
  }
  return { fields, tail: existing.tail };
}

/**
 * Upsert `gist-url` into a parsed sidecar (overwrite if present, else append
 * after the scalar block). Returns a new ParsedSidecar.
 */
export function upsertGistUrl(
  sidecar: ParsedSidecar,
  url: string,
): ParsedSidecar {
  const fields = new Map(sidecar.fields);
  fields.set("gist-url", url);
  return { fields, tail: sidecar.tail };
}

/**
 * Atomic write: stage into a temp file in the SAME directory (so `rename` is a
 * same-filesystem atomic swap) then rename over the destination. A killed
 * process leaves either the old sidecar or the new one intact, never a torn
 * write. NEVER throws past the caller's outer guard, but the caller is expected
 * to wrap this — a write failure here is a real error, not a fail-open no-op.
 */
export function atomicWrite(destPath: string, content: string): void {
  const tmp = join(
    dirname(destPath),
    `.${Date.now()}-${process.pid}.sidecar.tmp`,
  );
  writeFileSync(tmp, content);
  renameSync(tmp, destPath);
}

/**
 * The sidecar path for a doc `.md` path: same dir + basename, `.yaml` suffix.
 */
export function sidecarPathFor(mdPath: string): string {
  return mdPath.replace(/\.md$/, ".yaml");
}

/**
 * Load + parse an existing sidecar, or an empty {@link ParsedSidecar} when it
 * is absent/unreadable.
 */
export function loadSidecar(sidecarPath: string): ParsedSidecar {
  if (!existsSync(sidecarPath)) {
    return { fields: new Map(), tail: "" };
  }
  try {
    return parseSidecarText(readFileSync(sidecarPath, "utf8"));
  } catch {
    return { fields: new Map(), tail: "" };
  }
}
