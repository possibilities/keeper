#!/usr/bin/env bun
/**
 * docs-migrate — one-shot, re-runnable migration of `~/docs` to the metadata
 * sidecar shape (fn-884 `.4`). Strips the machine-stamped `## Metadata` trailer
 * out of every `.md` body and lands that metadata in a per-doc `.yaml` sidecar,
 * so a `.md` carries prose only and the sidecar owns the machine fields.
 *
 * The strip-signature detector and the sidecar read/merge/serialize logic are
 * NOT re-derived here — they are imported from `src/sidecar.ts` (task `.1`), the
 * single home of that regex so the migration and the live keeper hook can never
 * drift. This script adds only the migration-specific glue: parsing the stamped
 * EOF block into sidecar fields, classifying each doc, and sparse-backfilling a
 * sidecar for a doc that never carried a stamp.
 *
 * Conservative + idempotent by construction:
 *  - {@link stripDocSignature} only removes a `## Metadata` block confirmed to be
 *    a machine stamp (its ```yaml fence carries `session-id:` AND `path:`); a
 *    hand-authored `## N. Metadata` section has neither and survives untouched.
 *  - A second run is a no-op: an already-stripped `.md` has no signature, and an
 *    existing sidecar is loaded + merged (creation stamp preserved), so nothing
 *    changes.
 *  - The bounded {@link extractGistUrl} is applied to every `gist-url` it
 *    touches, fixing the 4 docs whose URL swallowed a JSON tail under the old
 *    greedy arthack regex; on an already-clean URL it is a no-op.
 *
 * Safe by default: a bare invocation only DRY-RUNS — it classifies, prints
 * counts, and writes nothing. Mutation happens only under `--apply`. The caller
 * is expected to `git tag pre-migration-<date>` and commit in tranches around
 * the `--apply` run; this script does not touch git.
 *
 * Usage:
 *   bun scripts/docs-migrate.ts                 # dry-run: classify + counts
 *   bun scripts/docs-migrate.ts --apply         # strip + write sidecars
 *   bun scripts/docs-migrate.ts --help
 *
 * Options:
 *   --apply             Perform the strip + sidecar writes (default: dry-run).
 *   --docs-dir <path>   Override the docs dir (default: $KEEPER_DOCS_DIR or
 *                       ~/docs). Hermetic tests point this at a tmpdir.
 *   --help              Print this and exit 0.
 */

import { execFileSync } from "node:child_process";
import {
  type Dirent,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  extractGistUrl,
  loadSidecar,
  mergeSidecarFields,
  type ParsedSidecar,
  serializeSidecar,
  sidecarPathFor,
  stripDocSignature,
} from "../src/sidecar";

/** Directories never descended into. */
const SKIP_DIRS = new Set([".git", ".kit"]);
/** Basenames never migrated. */
const SKIP_FILES = new Set(["README.md"]);

/** Resolve the docs dir: explicit override → `$KEEPER_DOCS_DIR` → `~/docs`. */
function resolveDocsDir(override: string | null): string {
  if (override && override.length > 0) {
    return override;
  }
  const env = process.env.KEEPER_DOCS_DIR;
  if (env && env.length > 0) {
    return env;
  }
  return join(homedir(), "docs");
}

/** Recursively collect `.md` paths under `dir`, honoring the skip sets. */
export function walkDocs(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...walkDocs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !SKIP_FILES.has(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `date +%Y-%m-%dT%H:%M:%S%z` parity (mirrors sidecar-writer.isoWithOffset). */
export function isoWithOffset(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${stamp}${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/**
 * Parse the machine-stamped EOF block of a doc body into sidecar fields. Returns
 * an empty map when the body has no machine stamp (same detector gate as the
 * stripper: a `## Metadata` heading whose ```yaml fence carries `session-id:`
 * AND `path:`). Migration-specific extraction — NOT the strip regex.
 *
 * The stamped yaml fence keys (`cwd`, `session-id`, `session-name`, `path`,
 * `gist-url`) already match the sidecar's own scalar keys, so they map through
 * 1:1. `gist-url` is run through the bounded {@link extractGistUrl} to drop any
 * swallowed JSON tail. The ```sh fence's `claude --resume ...` line becomes the
 * `resume` field; `type` is forced to `doc`.
 */
export function extractStampFields(body: string): Map<string, string> {
  const headingRe = /^## Metadata$/gm;
  let lastIdx = -1;
  for (let m = headingRe.exec(body); m !== null; m = headingRe.exec(body)) {
    lastIdx = m.index;
  }
  if (lastIdx === -1) {
    return new Map();
  }
  return parseStampTrailer(body.slice(lastIdx));
}

/**
 * Parse a stamp trailer (everything from the heading-or-fence onward) into
 * sidecar fields. The trailer's first ```yaml fence must carry `session-id:` AND
 * `path:` to be a confirmed machine stamp; otherwise an empty map is returned.
 * `gist-url` is bounded via {@link extractGistUrl}; the following ```sh fence
 * becomes `resume`; `type` defaults to `doc`. Shared by both the heading and
 * headingless (bare-fence) stamp variants.
 */
function parseStampTrailer(trailer: string): Map<string, string> {
  const fields = new Map<string, string>();
  const yamlStart = trailer.indexOf("```yaml");
  if (yamlStart === -1) {
    return fields;
  }
  const yamlEnd = trailer.indexOf("```", yamlStart + "```yaml".length);
  if (yamlEnd === -1) {
    return fields;
  }
  const fence = trailer.slice(yamlStart + "```yaml".length, yamlEnd);
  if (!/^session-id:/m.test(fence) || !/^path:/m.test(fence)) {
    return fields;
  }

  for (const raw of fence.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    if (key === "gist-url") {
      value = extractGistUrl(value) ?? value;
    }
    if (value.length > 0) {
      fields.set(key, value);
    }
  }
  if (!fields.has("type")) {
    fields.set("type", "doc");
  }

  // The ```sh fence carries the resume command.
  const shStart = trailer.indexOf("```sh", yamlEnd);
  if (shStart !== -1) {
    const shEnd = trailer.indexOf("```", shStart + "```sh".length);
    if (shEnd !== -1) {
      const resume = trailer.slice(shStart + "```sh".length, shEnd).trim();
      if (resume.length > 0 && !fields.has("resume")) {
        fields.set("resume", resume);
      }
    }
  }
  return fields;
}

/**
 * A handful of legacy stamps (6 of 340) were appended WITHOUT a `## Metadata`
 * heading — just a bare ```yaml fence (then a ```sh resume fence) at EOF.
 * {@link stripDocSignature} anchors on the heading and so misses these; this
 * supplemental detector handles ONLY the headingless EOF shape. It is NOT in
 * `src/sidecar.ts` because the live keeper hook never emits a stamp into a `.md`
 * at all — the bare-fence shape is purely legacy migration debt.
 *
 * Gated as strictly as the heading detector: the LAST ```yaml fence must reach
 * EOF (only a trailing ```sh fence + whitespace may follow), and must carry
 * `session-id:` AND `path: <docs path>`. A doc that quotes a fence mid-body, or
 * carries top-of-file frontmatter, does not match. Returns the strip index
 * (where to cut the body) or -1 when no bare-fence stamp is present.
 */
export function bareFenceStampIndex(body: string): number {
  const fenceRe = /^```yaml$/gm;
  let lastIdx = -1;
  for (let m = fenceRe.exec(body); m !== null; m = fenceRe.exec(body)) {
    lastIdx = m.index;
  }
  if (lastIdx === -1) {
    return -1;
  }
  const trailer = body.slice(lastIdx);
  // Confirm the fence is a machine stamp.
  const yamlEnd = trailer.indexOf("```", "```yaml".length);
  if (yamlEnd === -1) {
    return -1;
  }
  const fence = trailer.slice("```yaml".length, yamlEnd);
  if (!/^session-id:/m.test(fence) || !/^path: \/[^\n]*\.md$/m.test(fence)) {
    return -1;
  }
  // Everything after the yaml fence must be only the optional ```sh resume
  // fence + whitespace — i.e. this fence really is the EOF stamp, not a fence
  // embedded mid-body. A `## Metadata` heading variant is handled elsewhere;
  // if one precedes this fence the heading stripper already removed it.
  const after = trailer.slice(yamlEnd + "```".length);
  if (!/^\s*(?:```sh\b[\s\S]*?```\s*)?$/.test(after)) {
    return -1;
  }
  // Trim back over a preceding `---` thematic break + blank lines.
  const head = body.slice(0, lastIdx);
  const sepMatch = head.match(/\n+(?:---\s*\n)?\s*$/);
  return sepMatch ? (sepMatch.index ?? lastIdx) : lastIdx;
}

/** Field map for a headingless bare-fence EOF stamp, or empty when absent. */
export function extractBareFenceStampFields(body: string): Map<string, string> {
  const idx = bareFenceStampIndex(body);
  if (idx === -1) {
    return new Map();
  }
  return parseStampTrailer(body.slice(idx));
}

/**
 * Strip a headingless bare-fence EOF stamp from a body, or return the body
 * unchanged when none is present. Idempotent and conservative (same gate as
 * {@link bareFenceStampIndex}). Complements {@link stripDocSignature}.
 */
export function stripBareFenceStamp(body: string): string {
  const idx = bareFenceStampIndex(body);
  if (idx === -1) {
    return body;
  }
  return `${body.slice(0, idx).replace(/\s+$/, "")}\n`;
}

/**
 * First-commit ISO date for a tracked file, or null. `%aI` carries a colon in
 * the offset (`-04:00`); we normalize to the sidecar's `%z` shape (`-0400`).
 */
function gitCreated(docsDir: string, path: string): string | null {
  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        docsDir,
        "log",
        "--diff-filter=A",
        "--follow",
        "--format=%aI",
        "--",
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" },
    );
    const lines = out
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    const first = lines[lines.length - 1];
    if (!first) {
      return null;
    }
    return first.replace(/([+-]\d{2}):(\d{2})$/, "$1$2");
  } catch {
    return null;
  }
}

/** mtime in the sidecar's `%z` shape — the `created` fallback for untracked docs. */
function mtimeCreated(path: string): string {
  return isoWithOffset(statSync(path).mtime);
}

/** A doc's sparse backfill fields: `path`, `type: doc`, `created`. */
export function sparseFields(
  mdPath: string,
  docsDir: string,
  relPath: string,
): Map<string, string> {
  const fields = new Map<string, string>();
  fields.set("path", mdPath);
  fields.set("type", "doc");
  fields.set("created", gitCreated(docsDir, relPath) ?? mtimeCreated(mdPath));
  return fields;
}

/**
 * Apply the bounded gist-url fix to a parsed sidecar's `gist-url` in place-ish.
 * Returns true when the value changed (a swallowed JSON tail was trimmed). A
 * clean URL is left byte-identical.
 */
export function fixSidecarGistUrl(sidecar: ParsedSidecar): boolean {
  const cur = sidecar.fields.get("gist-url");
  if (cur === undefined) {
    return false;
  }
  const fixed = extractGistUrl(cur);
  if (fixed && fixed !== cur) {
    sidecar.fields.set("gist-url", fixed);
    return true;
  }
  return false;
}

interface DocResult {
  /** Body carried a confirmed machine stamp. */
  stamped: boolean;
  /** A sidecar already existed on disk. */
  hadSidecar: boolean;
  /** The strip produced a strictly-shorter body. */
  stripped: boolean;
  /** A corrupted `gist-url` was repaired in the sidecar. */
  gistFixed: boolean;
}

/**
 * Migrate one doc. Strips the stamp from the `.md` (only when confirmed), and
 * create-or-merges the sidecar. With `apply=false` nothing is written — the
 * returned classification still reflects what WOULD happen. Throws on a strip
 * that fails the strictly-shorter invariant (a real bug, never swallowed).
 */
export function migrateDoc(
  mdPath: string,
  docsDir: string,
  relPath: string,
  apply: boolean,
): DocResult {
  const body = readFileSync(mdPath, "utf8");

  // Two stamp shapes: the heading-anchored `## Metadata` block (the common one,
  // 334 docs) and a headingless bare-fence variant at EOF (6 legacy docs). The
  // heading strip runs first; the bare-fence strip then runs on its output (a
  // doc never carries both, but composing is safe and idempotent).
  let stripped = stripDocSignature(body);
  let stampFields = extractStampFields(body);
  if (stampFields.size === 0) {
    const bareFields = extractBareFenceStampFields(stripped);
    if (bareFields.size > 0) {
      stampFields = bareFields;
      stripped = stripBareFenceStamp(stripped);
    }
  }
  const stamped = stampFields.size > 0;

  const didStrip = stripped.length < body.length;
  if (stamped && !didStrip) {
    throw new Error(
      `stamp detected but strip was a no-op (or grew the body): ${mdPath}`,
    );
  }
  if (didStrip && stripped.length >= body.length) {
    throw new Error(`strip did not shorten the body: ${mdPath}`);
  }

  const sidecarPath = sidecarPathFor(mdPath);
  const existing = loadSidecar(sidecarPath);
  const hadSidecar = existing.fields.size > 0 || existing.tail.length > 0;

  // Incoming fields: the parsed stamp when present, else a sparse backfill.
  const incoming = stamped
    ? buildStampSidecarFields(mdPath, stampFields, docsDir, relPath)
    : sparseFields(mdPath, docsDir, relPath);
  const merged = mergeSidecarFields(existing, incoming);
  const gistFixed = fixSidecarGistUrl(merged);

  if (apply) {
    if (didStrip) {
      writeFileSync(mdPath, stripped);
    }
    atomicWrite(sidecarPath, serializeSidecar(merged));
  }

  return { stamped, hadSidecar, stripped: didStrip, gistFixed };
}

/**
 * Compose the sidecar fields for a stamped doc: `path` + `type` + a `created`
 * (the stamp carries none, so derive it) + the stamp's own scalars. Field order
 * mirrors the live hook (`path`, `type`, `created`, then the rest).
 */
function buildStampSidecarFields(
  mdPath: string,
  stampFields: Map<string, string>,
  docsDir: string,
  relPath: string,
): Map<string, string> {
  const fields = new Map<string, string>();
  fields.set("path", mdPath);
  fields.set("type", "doc");
  fields.set("created", gitCreated(docsDir, relPath) ?? mtimeCreated(mdPath));
  for (const [k, v] of stampFields) {
    if (k === "path" || k === "type") {
      continue;
    }
    fields.set(k, v);
  }
  return fields;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "bun scripts/docs-migrate.ts [--apply] [--docs-dir <path>]\n",
    );
    return 0;
  }
  const apply = args.includes("--apply");
  const dirIdx = args.indexOf("--docs-dir");
  const docsDir = resolveDocsDir(
    dirIdx !== -1 ? (args[dirIdx + 1] ?? null) : null,
  );

  const mdPaths = walkDocs(docsDir).sort();
  const counts = {
    total: mdPaths.length,
    stamped: 0,
    hadSidecar: 0,
    stripped: 0,
    sparseBackfill: 0,
    gistFixed: 0,
  };
  for (const mdPath of mdPaths) {
    const relPath = mdPath.startsWith(`${docsDir}/`)
      ? mdPath.slice(docsDir.length + 1)
      : mdPath;
    const r = migrateDoc(mdPath, docsDir, relPath, apply);
    if (r.stamped) {
      counts.stamped++;
    }
    if (r.hadSidecar) {
      counts.hadSidecar++;
    }
    if (r.stripped) {
      counts.stripped++;
    }
    if (!r.stamped && !r.hadSidecar) {
      counts.sparseBackfill++;
    }
    if (r.gistFixed) {
      counts.gistFixed++;
    }
  }

  // ABORT guard: a zero auto-stamp count on a fresh tree means the signature is
  // wrong (the detector matched nothing). It is legitimately zero only on a
  // re-run of an already-migrated tree, so the guard fires only when NOTHING
  // else changed either (no strips) AND we are not already all-sidecar'd.
  if (
    counts.total > 0 &&
    counts.stamped === 0 &&
    counts.stripped === 0 &&
    counts.hadSidecar < counts.total
  ) {
    process.stderr.write(
      "ABORT: zero auto-stamp matches AND zero strips on a tree that is not " +
        "fully sidecar'd — the stamp signature is likely wrong. Refusing.\n",
    );
    process.stderr.write(`${JSON.stringify(counts)}\n`);
    return 2;
  }

  process.stdout.write(`${apply ? "[apply]" : "[dry-run]"} docs-migrate\n`);
  process.stdout.write(`  docs-dir:        ${docsDir}\n`);
  process.stdout.write(`  total .md:       ${counts.total}\n`);
  process.stdout.write(`  auto-stamped:    ${counts.stamped}\n`);
  process.stdout.write(`  had sidecar:     ${counts.hadSidecar}\n`);
  process.stdout.write(`  stripped:        ${counts.stripped}\n`);
  process.stdout.write(`  sparse backfill: ${counts.sparseBackfill}\n`);
  process.stdout.write(`  gist-url fixed:  ${counts.gistFixed}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
