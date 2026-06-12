// Config loader — the port of planctl/config.py's narrow `roots:` surface.
//
// `~/.config/planctl/config.yaml` carries a single key, `roots:` (a list of
// parent directories planctl scans for sibling projects). Absent file → default
// `[~/code]`. Each root is expanduser'd + resolved to an absolute path.
// Malformed YAML / wrong-typed `roots:` falls back to the default rather than
// hard-breaking — discovery must degrade soft, never crash.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { parseYamlInput } from "./yaml_input.ts";

// Default roots when the config file is absent or unusable.
const DEFAULT_ROOTS = ["~/code"];

/** Home directory honoring $HOME first (Python's Path.expanduser checks the
 * HOME env var before the password database; tests rely on a mutated $HOME). */
function home(): string {
  return process.env.HOME || homedir();
}

/** Expand a leading `~` to the home directory (Python Path.expanduser). A bare
 * `~` or `~/...` expands; `~user` is left as-is (planctl never uses it). */
function expanduser(p: string): string {
  if (p === "~") {
    return home();
  }
  if (p.startsWith("~/")) {
    return `${home()}${p.slice(1)}`;
  }
  return p;
}

/** Resolve a path absolutely, then realpath when it exists — mirrors Python's
 * Path.resolve(), which canonicalizes symlinks for an existing path and returns
 * the lexically-absolute path for a non-existent one. */
function resolvePath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Expanduser + resolve each entry; drop non-string / empty entries. Mirrors
 * config._normalize_roots. */
function normalizeRoots(rawRoots: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of rawRoots) {
    if (typeof entry !== "string" || entry.trim() === "") {
      continue;
    }
    out.push(resolvePath(expanduser(entry)));
  }
  return out;
}

/** The conventional config path: `~/.config/planctl/config.yaml`. XDG_CONFIG_HOME
 * is intentionally NOT consulted (Python pins the literal path). */
function configPath(): string {
  return `${home()}/.config/planctl/config.yaml`;
}

/** Return the configured `roots` as resolved absolute paths. Mirrors
 * config.load_roots:
 *   - File absent → default `[~/code]`.
 *   - File present but unreadable / malformed YAML / `roots` missing or not a
 *     list → default `[~/code]` (fail-soft).
 *   - Valid `roots` list → each entry expanded/resolved; non-string / empty
 *     dropped. An empty resulting list falls back to the default. */
export function loadRoots(path?: string): string[] {
  const p = path ?? configPath();

  let rawRoots: unknown[] | null = null;
  if (existsSync(p)) {
    try {
      // PARSER UNITY: config shares the scaffold/refine-apply YAML wrapper
      // (eemeli 1.1, duplicate-key last-wins) so all bun YAML input parses one
      // way. Fail-soft is preserved — a parse/UTF-8 throw degrades to default.
      const data = parseYamlInput(readFileSync(p), p);
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const candidate = (data as Record<string, unknown>).roots;
        if (Array.isArray(candidate)) {
          rawRoots = candidate;
        }
      }
    } catch {
      rawRoots = null;
    }
  }

  if (rawRoots === null) {
    rawRoots = [...DEFAULT_ROOTS];
  }

  let resolved = normalizeRoots(rawRoots);
  if (resolved.length === 0) {
    resolved = normalizeRoots(DEFAULT_ROOTS);
  }
  return resolved;
}
