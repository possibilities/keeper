// Vendored keeper-relevant snippet corpus — filter spec, lock schema, drift check.
//
// The prompt corpus is authored upstream in the arthack repo; keeper vendors a
// keeper-relevant subset under `plugins/prompt/corpus/` so `keeper prompt render
// <ref>` resolves from keeper's own root with no arthack checkout present. The
// subset is a filter over the upstream corpus — whole snippet domains + whole
// bundles (see FILTER); cherry-picking bundle members would leave bundle renders
// incoherent. It is captured with a `vendor.lock` recording the upstream commit
// SHA, the filter rule, and a per-file sha256 manifest.
//
// Two-way drift is by design: the lock IS the review point. `verifyVendorLock`
// (the drift gate, run in CI via the prompt suite) re-hashes the vendored tree
// against the manifest, so a hand-edit not reflected in the lock fails loud. The
// generator that (re)builds the subset + lock from an arthack checkout lives at
// `scripts/vendor-corpus.ts`.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import { vendoredCorpusRoot } from "./project_root.ts";
import { render } from "./render.ts";

export { vendoredCorpusRoot };

/** The subset filter over the upstream corpus: whole snippet domains + whole
 * bundles. Covers every `keeper prompt render <ref>` cite in keeper/plan skill
 * bodies plus the engineering-rules members, so bundle renders stay coherent. */
export const FILTER = {
  /** Whole snippet domains under `_partials/snippets/<domain>/`. */
  domains: ["engineering", "source-dirs"],
  /** Whole bundles under `_partials/bundles/<name>.yaml`. */
  bundles: ["engineering-rules"],
} as const;

/** Human-readable filter rule recorded in the lock's `filter_rule`. */
export const FILTER_RULE =
  "whole snippet domains {engineering, source-dirs} + whole bundle " +
  "{engineering-rules}; covers every `keeper prompt render` cite in keeper/plan " +
  "skill bodies plus the engineering-rules members for coherent bundle renders";

/** Basename of the lock, resolved next to the vendored corpus root. */
export const LOCK_NAME = "vendor.lock";

/** Provenance + per-file digest manifest for the vendored subset. */
export interface VendorLock {
  upstream: { repo: string; remote?: string; path: string; sha: string };
  filter_rule: string;
  /** vendored-root-relative posix path -> sha256 hex of the file's bytes. */
  files: Record<string, string>;
}

/** Absolute path to the lock file. */
export function vendorLockPath(root: string = vendoredCorpusRoot()): string {
  return join(root, LOCK_NAME);
}

/** sha256 hex of a file's bytes. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every vendored file as sorted vendored-root-relative posix paths, excluding
 * the lock itself (it cannot hash itself). */
export function vendoredFiles(root: string = vendoredCorpusRoot()): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const full = join(cur, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.filter((p) => p !== LOCK_NAME).sort();
}

/** `{ relpath -> sha256 }` for every vendored file (excluding the lock). */
export function computeManifest(
  root: string = vendoredCorpusRoot(),
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of vendoredFiles(root)) {
    files[rel] = sha256File(join(root, rel));
  }
  return files;
}

/** Load + minimally validate the lock. Throws when absent or malformed. */
export function loadVendorLock(
  root: string = vendoredCorpusRoot(),
): VendorLock {
  const path = vendorLockPath(root);
  const data = yaml.load(readFileSync(path, "utf-8")) as VendorLock | null;
  if (
    data === null ||
    typeof data !== "object" ||
    typeof data.filter_rule !== "string" ||
    typeof data.upstream?.sha !== "string" ||
    typeof data.files !== "object" ||
    data.files === null
  ) {
    throw new Error(`malformed ${LOCK_NAME} at ${path}`);
  }
  return data;
}

/** Serialize a lock to deterministic YAML (stable key order, wide lines) with a
 * provenance header, so re-running the generator churns only real changes. */
export function serializeVendorLock(lock: VendorLock): string {
  const header =
    "# Provenance for the vendored keeper-relevant snippet corpus subset.\n" +
    "# Upstream authoring home is the arthack corpus; two-way drift is by design —\n" +
    "# this lock IS the review point. Regenerate with scripts/vendor-corpus.ts; the\n" +
    "# prompt-suite drift test re-hashes the vendored tree against `files` below.\n";
  const body = yaml.dump(lock, {
    sortKeys: false,
    lineWidth: 10_000,
    noCompatMode: true,
  });
  return `${header}${body}`;
}

/** Outcome of the drift check: the errors are the human-facing failure lines. */
export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/** Re-hash the vendored tree and compare against the lock manifest. Flags an
 * on-disk file the lock does not record, a recorded file gone missing, and any
 * content drift (hash mismatch). Self-contained — needs no arthack checkout. */
export function verifyVendorLock(
  root: string = vendoredCorpusRoot(),
): VerifyResult {
  const errors: string[] = [];
  const lock = loadVendorLock(root);
  const actual = computeManifest(root);
  const locked = lock.files;
  for (const p of Object.keys(actual)) {
    if (!(p in locked)) {
      errors.push(`vendored file not recorded in ${LOCK_NAME}: ${p}`);
    }
  }
  for (const p of Object.keys(locked)) {
    if (!(p in actual)) {
      errors.push(`${LOCK_NAME} records a file missing on disk: ${p}`);
      continue;
    }
    if (actual[p] !== locked[p]) {
      errors.push(`content drift (re-vendor + bump ${LOCK_NAME}): ${p}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- Baked-snippet drift gate --------------------------------------------
//
// A skill body carries a snippet two ways. A BAKE guard wraps a byte-verbatim
// copy of the render — `verifyBakes` re-renders and asserts identity, so an
// upstream edit that isn't re-baked fails loud. A POINTER marker sits above a
// skill-SPECIFIC summary that is deliberately NOT verbatim — the gate only
// checks its ref still resolves, never its bytes.

/** BAKE:BEGIN/END guard pair. `\S+` is the render ref; the body is captured
 * between the markers (surrounding blank-line padding normalized away). */
const BAKE_RE =
  /<!-- BAKE:BEGIN keeper prompt render (\S+) -->\n([\s\S]*?)<!-- BAKE:END keeper prompt render (\S+) -->/g;

/** POINTER marker above a skill-specific (non-verbatim) summary. */
const POINTER_RE = /<!-- POINTER: keeper prompt render (\S+) -->/g;

/** Strip surrounding blank-line padding; a snippet body never leads or trails
 * with a blank line, so this recovers the render's exact bytes (single trailing
 * newline) from a guarded region regardless of author spacing. */
function normalizeBake(s: string): string {
  return `${s.replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
}

/** Count of BAKE guards in a skill body — lets callers assert none were lost. */
export function bakeCount(text: string): number {
  return Array.from(text.matchAll(BAKE_RE)).length;
}

/** Assert every BAKE guard in `skillPath` equals its render byte-for-byte, and
 * every POINTER ref resolves. Renders come from the vendored corpus, so this is
 * the same source the running skill cites. */
export function verifyBakes(
  skillPath: string,
  corpusRoot: string = vendoredCorpusRoot(),
): VerifyResult {
  const errors: string[] = [];
  const text = readFileSync(skillPath, "utf-8");
  const silent = (): void => {};
  for (const m of text.matchAll(BAKE_RE)) {
    const beginRef = m[1] as string;
    const body = m[2] as string;
    const endRef = m[3] as string;
    if (beginRef !== endRef) {
      errors.push(`bake guard ref mismatch: BEGIN ${beginRef} / END ${endRef}`);
      continue;
    }
    let rendered: string;
    try {
      rendered = render(beginRef, corpusRoot, silent);
    } catch (e) {
      errors.push(`bake ${beginRef}: render failed: ${errMsg(e)}`);
      continue;
    }
    if (normalizeBake(body) !== normalizeBake(rendered)) {
      errors.push(
        `bake drift (re-sync the guarded region to ` +
          `\`keeper prompt render ${beginRef}\`): ${beginRef}`,
      );
    }
  }
  for (const m of text.matchAll(POINTER_RE)) {
    const ref = m[1] as string;
    try {
      render(ref, corpusRoot, silent);
    } catch (e) {
      errors.push(`pointer ${ref}: render failed: ${errMsg(e)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
