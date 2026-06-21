// Storage path resolution for `keeper prompt` runtime substrate namespaces.
//
// Each namespace prefix maps to exactly one storage root under the corpus
// project root:
//
//   bundle/<name>  -> <root>/claude/arthack/template/_partials/bundles/<name>.yaml
//   sketch/<name>  -> <root>/.promptctl/sketches/<name>.yaml  (write-time only)
//
// The segment + join helpers reject `..`, leading `/`, NUL bytes, path
// separators, and empty segments before touching the filesystem, then assert the
// resolved path stays contained within its expected root. Port of storage.py's
// validate_segment / safe_join / per-namespace roots.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Raised when a storage path is unsafe, malformed, or escapes its root. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** Reject path-traversal-bait segments before they ever hit the filesystem. A
 * segment is unsafe if it is empty, contains a NUL byte, contains `/` or `\`,
 * equals `.` or `..`, or starts with `/`. Mirrors storage.py validate_segment. */
export function validateSegment(segment: string, label = "ref"): void {
  if (!segment) {
    throw new StorageError(`${label}: empty path segment`);
  }
  if (segment.includes("\x00")) {
    throw new StorageError(`${label}: NUL byte in segment ${quote(segment)}`);
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new StorageError(
      `${label}: segment ${quote(segment)} contains a path separator`,
    );
  }
  if (segment === "." || segment === "..") {
    throw new StorageError(
      `${label}: segment ${quote(segment)} is a relative-path marker`,
    );
  }
}

/** Join `parts` under `root`, validating each part as a single safe segment and
 * asserting the resolved result is contained within `root`. Raises StorageError
 * on any violation. Mirrors storage.py safe_join. */
export function safeJoin(root: string, parts: string[], label = "ref"): string {
  if (parts.length === 0) {
    throw new StorageError(`${label}: no path parts supplied`);
  }
  for (const p of parts) {
    validateSegment(p, label);
  }
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, ...parts);
  if (!isContained(candidate, rootResolved)) {
    throw new StorageError(
      `${label}: resolved path ${candidate} escapes root ${rootResolved}`,
    );
  }
  return candidate;
}

/** True when `candidate` is `root` itself or lives beneath it. The `sep` guard
 * stops a sibling whose name merely shares the root's prefix from passing
 * (`/a/bc` is not contained in `/a/b`). */
function isContained(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Create `path`'s parent directory if missing (no-op when present). */
export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** `<projectRoot>/.promptctl/` — the project-local state dir. */
export function promptctlRoot(projectRoot: string): string {
  return join(projectRoot, ".promptctl");
}

/** Create `.promptctl/` and drop a self-ignoring `.gitignore` (`*`) when absent.
 * Idempotent: a human's customized `.gitignore` is never clobbered. Returns the
 * `.promptctl` path. Mirrors storage.py ensure_self_ignored. */
export function ensureSelfIgnored(projectRoot: string): string {
  const root = promptctlRoot(projectRoot);
  mkdirSync(root, { recursive: true });
  const gitignore = join(root, ".gitignore");
  try {
    writeFileSync(gitignore, "*\n", { flag: "wx" });
  } catch (err) {
    if (!isExistsError(err)) {
      throw err;
    }
  }
  return root;
}

/** Directory containing `bundle/<name>` YAMLs (in the plugin/corpus tree). */
export function bundleRoot(projectRoot: string): string {
  return join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "bundles",
  );
}

/** Directory containing `sketch/<name>` YAMLs (project-scoped, gitignored). */
export function sketchRoot(projectRoot: string): string {
  return join(projectRoot, ".promptctl", "sketches");
}

function quote(s: string): string {
  return `'${s}'`;
}

function isExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "EEXIST"
  );
}
