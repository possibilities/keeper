// Repo-path expansion — the port of planctl/repo_inference.expand_path.
//
// expandPath is the THROWING twin of store.resolveUserPath: where
// resolveUserPath never throws (a non-existent path still normalizes to its
// absolute form, used by the repo setters), expandPath deliberately raises when
// a leading ``~`` cannot be resolved (no ``$HOME``, unknown user). The callers
// (epic create, scaffold, refine-apply, set-target-repo) catch the throw and
// surface a typed failure (e.g. repo_invalid) instead of writing a path that
// silently still contains a literal ``~``. Two helpers, both survive.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Expand a leading ``~`` and resolve to an absolute path string. Mirrors
 * ``str(Path(path_str).expanduser().resolve())``.
 *
 * THROWS when a leading ``~`` / ``~/`` cannot be expanded because no home
 * directory is resolvable (no ``$HOME`` and no password-db home) — the parity
 * of Python ``expanduser`` raising RuntimeError on an unresolvable ``~``. A
 * ``~user`` form planctl never emits is likewise unresolvable here and throws.
 * A non-existent (but resolvable) path normalizes to its absolute form. */
export function expandPath(pathStr: string): string {
  let expanded = pathStr;
  if (pathStr === "~" || pathStr.startsWith("~/")) {
    const home = resolvableHome();
    if (home === null) {
      throw new Error(`Could not expand ~: no home directory for ${pathStr}`);
    }
    expanded = home + pathStr.slice(1);
  } else if (pathStr.startsWith("~")) {
    // ``~user`` — Python expanduser raises if the user can't be resolved;
    // planctl never emits this form, so treat it as unresolvable.
    throw new Error(`Could not expand ~: unsupported ~user form ${pathStr}`);
  }

  const abs = isAbsolute(expanded)
    ? expanded
    : resolve(process.cwd(), expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The home directory the way Python Path.expanduser resolves it: ``$HOME``
 * first, then the password-db home (os.homedir). null when neither resolves —
 * the signal expandPath turns into a throw. */
function resolvableHome(): string | null {
  const fromEnv = process.env.HOME;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const fromDb = homedir();
    return fromDb === "" ? null : fromDb;
  } catch {
    return null;
  }
}
