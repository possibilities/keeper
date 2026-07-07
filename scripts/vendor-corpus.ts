#!/usr/bin/env bun
// Vendor the keeper-relevant snippet corpus subset from an arthack checkout, or
// verify the in-repo subset against its lock.
//
//   bun scripts/vendor-corpus.ts --check                 (default) drift-verify only
//   bun scripts/vendor-corpus.ts --sync [<arthack-root>] rebuild subset + vendor.lock
//
// `--check` re-hashes `plugins/prompt/corpus/` against `vendor.lock` — self-
// contained, no arthack checkout needed; this is what the prompt-suite drift test
// asserts. `--sync` copies the filtered subset (whole domains + bundles, per
// FILTER in plugins/prompt/src/vendor.ts) out of an arthack checkout, rebuilds the
// filtered `_index.yaml`, and rewrites the lock with the upstream HEAD sha + a
// fresh per-file sha256 manifest. Run it deliberately to bump the lock — the lock
// IS the two-way-drift review point.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { serializeIndex } from "../plugins/prompt/src/build_snippets.ts";
import {
  computeManifest,
  FILTER,
  FILTER_RULE,
  serializeVendorLock,
  type VendorLock,
  type VerifyResult,
  vendoredCorpusRoot,
  vendorLockPath,
  verifyBakes,
  verifyVendorLock,
} from "../plugins/prompt/src/vendor.ts";

/** Templates dir relative to a corpus root, where snippet `path`s resolve. */
const TEMPLATES = ["claude", "arthack", "template"];
const CORPUS = vendoredCorpusRoot();
/** Skill bodies carrying the byte-verbatim bake guards this gate re-renders. */
const SKILLS_ROOT = resolve(
  CORPUS,
  "..",
  "..",
  "..",
  "plugins",
  "plan",
  "skills",
);
const HACK_SKILL = resolve(SKILLS_ROOT, "hack", "SKILL.md");
const PANEL_SKILL = resolve(SKILLS_ROOT, "panel", "SKILL.md");

interface IndexRow {
  name: string;
  domain?: string;
  path: string;
  [k: string]: unknown;
}

/** Load the `snippets` rows from a corpus root's `_index.yaml`. */
function loadIndexRows(root: string): IndexRow[] {
  const p = join(root, ...TEMPLATES, "_partials", "snippets", "_index.yaml");
  const data = yaml.load(readFileSync(p, "utf-8")) as {
    snippets?: IndexRow[];
  } | null;
  return data?.snippets ?? [];
}

/** Rebuild the vendored subset + lock from `arthackRoot`. */
function sync(arthackRoot: string): void {
  if (!existsSync(join(arthackRoot, ...TEMPLATES, "_partials"))) {
    fail(`arthack corpus not found under ${arthackRoot}`);
  }
  const domains = new Set<string>(FILTER.domains);
  const rows = loadIndexRows(arthackRoot).filter((r) =>
    domains.has(r.domain ?? ""),
  );
  const vendoredIds = new Set<string>();
  for (const r of rows) {
    vendoredIds.add(r.name);
    vendoredIds.add(`${r.domain ?? ""}/${r.name}`);
  }

  // Fresh tree — drop any snippet/bundle no longer in the filter.
  const templatesDst = join(CORPUS, ...TEMPLATES);
  rmSync(templatesDst, { recursive: true, force: true });

  // Snippet files, index-driven so files and index stay consistent.
  for (const r of rows) {
    const src = join(arthackRoot, ...TEMPLATES, ...r.path.split("/"));
    const dst = join(CORPUS, ...TEMPLATES, ...r.path.split("/"));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  // Bundles, whole; every member must be inside the vendored snippet set.
  for (const bundle of FILTER.bundles) {
    const rel = ["_partials", "bundles", `${bundle}.yaml`];
    const src = join(arthackRoot, ...TEMPLATES, ...rel);
    const dst = join(CORPUS, ...TEMPLATES, ...rel);
    const doc = yaml.load(readFileSync(src, "utf-8")) as {
      snippet_ids?: string[];
    } | null;
    for (const sid of doc?.snippet_ids ?? []) {
      if (!vendoredIds.has(sid)) {
        fail(`bundle ${bundle} references un-vendored snippet ${sid}`);
      }
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  // Filtered index — the subset's rows, deterministic serialization.
  const indexDst = join(
    CORPUS,
    ...TEMPLATES,
    "_partials",
    "snippets",
    "_index.yaml",
  );
  writeFileSync(indexDst, serializeIndex(rows as Record<string, unknown>[]));

  const sha = git(arthackRoot, ["rev-parse", "HEAD"]);
  const remote = tryGit(arthackRoot, ["remote", "get-url", "origin"]);
  const lock: VendorLock = {
    upstream: {
      repo: "arthack",
      ...(remote ? { remote } : {}),
      path: join(...TEMPLATES, "_partials"),
      sha,
    },
    filter_rule: FILTER_RULE,
    files: computeManifest(CORPUS),
  };
  writeFileSync(vendorLockPath(CORPUS), serializeVendorLock(lock));
  process.stdout.write(
    `vendored ${rows.length} snippets + ${FILTER.bundles.length} bundle(s) ` +
      `from arthack@${sha.slice(0, 12)} -> ${CORPUS}\n`,
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function fail(msg: string): never {
  process.stderr.write(`vendor-corpus: ${msg}\n`);
  process.exit(1);
}

function main(argv: string[]): void {
  const mode = argv.includes("--sync") ? "sync" : "check";
  if (mode === "sync") {
    const rest = argv.filter((a) => a !== "--sync");
    const arthackRoot = resolve(rest[0] ?? join(homedir(), "code", "arthack"));
    sync(arthackRoot);
    return;
  }
  const lockResult = verifyVendorLock(CORPUS);
  reportOrExit("vendored corpus drifted from vendor.lock", lockResult);
  for (const skill of [HACK_SKILL, PANEL_SKILL]) {
    reportOrExit(
      "baked snippets drifted from the vendored corpus",
      verifyBakes(skill, CORPUS),
    );
  }
  process.stdout.write(
    "vendor-corpus: vendored corpus matches vendor.lock; bakes match renders\n",
  );
}

function reportOrExit(label: string, result: VerifyResult): void {
  if (result.ok) {
    return;
  }
  process.stderr.write(`vendor-corpus: ${label}:\n`);
  for (const e of result.errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  process.exit(1);
}

main(Bun.argv.slice(2));
