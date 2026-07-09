#!/usr/bin/env bun
/**
 * Daemon load-surface fingerprint seam.
 *
 * Reads scripts/daemon-load-roots.txt (the declared load surface), resolves each
 * root to its object id at HEAD via `git rev-parse HEAD:<root>`, folds in the
 * manifest's own blob hash, and prints one content-addressed composite. The
 * install reload gate reloads keeperd only when the composite moves, so a
 * docs-only or board-checkpoint commit — which touches nothing keeperd loads —
 * leaves the daemon running.
 *
 * Decision core (parseRootsManifest, composeRevParseArgs, composeFingerprint) is
 * pure and unit-tested; the thin main() is the only impure part (git exec, fs
 * read, process.exit). The manifest paths are reviewed config, so git runs as an
 * argv array with no shell interpolation.
 *
 * Exit codes — install.sh keys on these, asymmetric by design:
 *   0  composite printed to stdout.
 *   1  LOUD failure — manifest unreadable/empty, a declared root did not resolve
 *      at HEAD, or the manifest blob could not be hashed. A manifest bug someone
 *      must fix; the install goes red rather than fingerprint a false boundary.
 *   3  git wholly undeterminable (not a repo / no HEAD / git missing). The caller
 *      degrades to the plist-content gate alone, matching a fresh-machine install.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MANIFEST_BASENAME = "daemon-load-roots.txt";

/** Parse the roots manifest: one path per line, `#` full-line comments and blank
 *  lines ignored, surrounding whitespace trimmed, file order preserved. The one
 *  parser the hashed boundary (this seam) and the enforced boundary (the boundary
 *  test) share, so the two cannot drift apart. */
export function parseRootsManifest(text: string): string[] {
  const roots: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    roots.push(line);
  }
  return roots;
}

/** The `git rev-parse` argv (after the binary) resolving each ref to its object
 *  id at HEAD. A directory ref yields a tree hash, a file ref a blob hash — both
 *  content-addressed and stable at a fixed HEAD. */
export function composeRevParseArgs(refs: string[]): string[] {
  return ["rev-parse", ...refs.map((r) => `HEAD:${r}`)];
}

export interface RootHash {
  root: string;
  hash: string;
}

/** Deterministic composite over the manifest's own blob hash plus each declared
 *  root's object id. Roots are sorted so argv/manifest order cannot perturb the
 *  digest; the manifest hash folds in so editing the declared set moves the
 *  fingerprint even when no root's content changed. */
export function composeFingerprint(input: {
  manifestHash: string;
  roots: RootHash[];
}): string {
  const lines = [`manifest ${input.manifestHash}`];
  const sorted = [...input.roots].sort((a, b) =>
    a.root < b.root ? -1 : a.root > b.root ? 1 : 0,
  );
  for (const { root, hash } of sorted) lines.push(`${root} ${hash}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ---- impure driver (runs only via `import.meta.main`) ----

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(repoRoot: string, args: string[]): GitResult {
  try {
    const res = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: res.exitCode ?? -1,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  } catch (err) {
    // git binary missing / unspawnable — wholly undeterminable, degrade.
    return { code: -1, stdout: "", stderr: String(err) };
  }
}

const EXIT_OK = 0;
const EXIT_LOUD = 1;
const EXIT_DEGRADE = 3;

function main(): number {
  const repoRoot = resolve(import.meta.dir, "..");
  const manifestRel = `scripts/${MANIFEST_BASENAME}`;
  const manifestPath = resolve(import.meta.dir, MANIFEST_BASENAME);

  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    console.error(`daemon-fingerprint: cannot read manifest ${manifestRel}`);
    return EXIT_LOUD;
  }
  const roots = parseRootsManifest(text);
  if (roots.length === 0) {
    console.error(`daemon-fingerprint: ${manifestRel} declares no roots`);
    return EXIT_LOUD;
  }

  // git availability gate — a fresh machine or a missing binary degrades.
  const head = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    console.error(
      "daemon-fingerprint: git wholly undeterminable (no HEAD / not a repo); degrading to the plist gate",
    );
    return EXIT_DEGRADE;
  }

  // Resolve every declared root at HEAD in one batched call.
  const res = runGit(repoRoot, composeRevParseArgs(roots));
  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (res.code !== 0 || lines.length !== roots.length) {
    // A declared root did not resolve — name the offender(s) with a per-root probe.
    const bad = roots.filter(
      (r) =>
        runGit(repoRoot, ["rev-parse", "--verify", `HEAD:${r}`]).code !== 0,
    );
    console.error(
      `daemon-fingerprint: declared load root(s) failed to resolve at HEAD: ${
        bad.join(", ") || "<unknown>"
      } — fix ${manifestRel}`,
    );
    return EXIT_LOUD;
  }
  const rootHashes: RootHash[] = roots.map((root, i) => ({
    root,
    hash: lines[i],
  }));

  // The manifest's own blob hash (content-addressed; committed or not).
  const mh = runGit(repoRoot, ["hash-object", "--", manifestRel]);
  const manifestHash = mh.stdout.trim();
  if (mh.code !== 0 || manifestHash.length === 0) {
    console.error(
      `daemon-fingerprint: cannot hash manifest blob ${manifestRel}`,
    );
    return EXIT_LOUD;
  }

  console.log(composeFingerprint({ manifestHash, roots: rootHashes }));
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(main());
}
