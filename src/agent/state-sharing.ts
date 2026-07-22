/**
 * Canonical global-instruction state sharing — the launch-time guard that keeps
 * each harness's shared instruction leaf (Claude's `CLAUDE.md` and Pi's `AGENTS.md`) symlinked back to keeper's one real `system/shared/AGENTS.md`
 * source, plus Claude's canonical `CLAUDE.md` and Pi's canonical account root.
 *
 * There is no Keeper-owned profile farm: claude-swap exclusively owns any
 * managed-account session directory, and Keeper neither discovers nor repairs
 * its private layout. Keeper still owns canonical Claude configuration:
 * `~/.claude/settings.json` and `~/.claude/CLAUDE.md` are checked against their
 * repository sources and re-asserted as symlinks before every Claude launch.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raised for fail-loud state errors; main() prints `Error: <msg>` + exit 1. */
export class StateError extends Error {}

/**
 * Resolve keeper's own `system/claude/.claude` source dir from this module's
 * location, then symlink-resolve it to a stable absolute path. This module sits
 * at `src/agent/state-sharing.ts`, so `../../system/claude/.claude` is the repo's
 * canonical Claude config (`settings.json`, `CLAUDE.md`) the launch guard
 * re-asserts. Mirrors `defaultKeeperAgentPath` — resolving through this module's
 * own path keeps the source correct under `bun link` (the linked binary reaches
 * the repo via a node_modules symlink; the `realpath` collapses it to one stable
 * target so the guard's relative link never churns across launches).
 */
export function defaultClaudeStowDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(here, "..", "..", "system", "claude", ".claude");
  try {
    return realpathSync(dir);
  } catch {
    // Partial checkout: fall back to the unresolved absolute path rather than
    // throwing on a pure path computation. The guard's `!existsSync` fail-open
    // handles the missing-source case at enforce time.
    return dir;
  }
}

/**
 * Resolve keeper's `system/shared` source dir — the home of the ONE real
 * `AGENTS.md` every harness's global-instruction leaf links back to. Mirrors
 * `defaultClaudeStowDir`: derived from this module's own path and symlink-resolved
 * to a stable absolute target so the guard's relative links never churn across
 * launches (the doc leaves MUST source from this REAL file, never a symlink, or
 * `readlink` would drift). Falls back to the unresolved path on a partial checkout.
 */
export function defaultSharedStowDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(here, "..", "..", "system", "shared");
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** lstat-based: true when the path itself exists (a broken symlink counts). */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a symlink's target to an absolute path (relative → relative to parent). */
function resolveLinkTarget(path: string): string {
  let linkTarget = readlinkSync(path);
  if (!isAbsolute(linkTarget)) {
    linkTarget = join(dirname(path), linkTarget);
  }
  return linkTarget;
}

/** True when `path` is a symlink resolving to `target` (resolved on both sides). */
function isSameSymlink(path: string, target: string): boolean {
  if (!isSymlink(path)) {
    return false;
  }
  let linkTarget: string;
  try {
    linkTarget = resolveLinkTarget(path);
  } catch {
    return false;
  }
  return normalizeAbsolute(linkTarget) === normalizeAbsolute(target);
}

/**
 * Lexically normalize a path to an absolute string — NO symlink dereferencing.
 * Used to compare symlink TARGET strings (the value stored in the link), which
 * must stay un-dereferenced: dereferencing would change comparison semantics.
 * This is `resolve()`, not `fs.realpathSync`.
 */
function normalizeAbsolute(p: string): string {
  return resolve(p);
}

/** How a canonical leaf's regular-file clobber is compared to its source:
 * `json` is whitespace/key-order-insensitive (settings.json); `bytes` is exact. */
export type LeafCompare = "json" | "bytes";

/**
 * What the guard does when a leaf's regular-file clobber diverges from its source:
 * `error` hard-throws (keeper-owned leaves); `warn` leaves the live file in place
 * and logs (human-owned global-instruction leaves — Pi).
 */
export type LeafDivergence = "error" | "warn";

/**
 * One canonical leaf the launch guard re-asserts: a symlink at `linkPath` that
 * must resolve to the repository `source`. `compare` selects semantic JSON or
 * exact-byte clobber equality; `onDivergence` selects fail-loud ownership or
 * warn-and-respect handling.
 */
export interface CanonicalStowLeaf {
  source: string;
  linkPath: string;
  compare: LeafCompare;
  onDivergence: LeafDivergence;
}

/** Keeper-owned Claude leaves. Null sources are test-only fail-open seams. */
function claudeStowLeaves(
  claudeStowDir: string | null,
  sharedStowDir: string | null,
  homeDir: string,
): CanonicalStowLeaf[] {
  const claudeDir = join(homeDir, ".claude");
  return [
    ...(claudeStowDir === null
      ? []
      : [
          {
            source: join(claudeStowDir, "settings.json"),
            linkPath: join(claudeDir, "settings.json"),
            compare: "json" as const,
            onDivergence: "error" as const,
          },
        ]),
    ...(sharedStowDir === null
      ? []
      : [
          {
            source: join(sharedStowDir, "AGENTS.md"),
            linkPath: join(claudeDir, "CLAUDE.md"),
            compare: "bytes" as const,
            onDivergence: "error" as const,
          },
        ]),
  ];
}

/** The pi canonical leaf: `<canonicalDir>/AGENTS.md` sourced from the shared file,
 *  warn-and-respect. */
function piCanonicalStowLeaves(
  sharedStowDir: string,
  canonicalDir: string,
): CanonicalStowLeaf[] {
  return [
    {
      source: join(sharedStowDir, "AGENTS.md"),
      linkPath: join(canonicalDir, "AGENTS.md"),
      compare: "bytes",
      onDivergence: "warn",
    },
  ];
}

/** Whitespace-insensitive, key-order-independent JSON equality. */
function jsonSemanticEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  let parsedA: unknown;
  let parsedB: unknown;
  try {
    parsedA = JSON.parse(a);
    parsedB = JSON.parse(b);
  } catch {
    return false;
  }
  return canonicalJson(parsedA) === canonicalJson(parsedB);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Quote one argv value for copy-pasteable POSIX shell recovery commands. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function divergentClobberMessage(
  linkPath: string,
  target: string,
  relTarget: string,
): string {
  const quotedLink = shellQuote(linkPath);
  const quotedTarget = shellQuote(target);
  const quotedRelativeTarget = shellQuote(relTarget);
  return [
    `Canonical Claude config drift: ${linkPath} is a regular file whose`,
    `contents differ from the repository source ${target}.`,
    "",
    "A direct edit or atomic write replaced the canonical symlink. Keeper will",
    "not pick a winner or overwrite either version. Resolve it one of these ways:",
    "",
    "  # 1. Inspect the difference",
    `  diff -u -- ${quotedTarget} ${quotedLink}`,
    "",
    "  # 2. Discard the live file and restore the repository link",
    `  rm -- ${quotedLink} && ln -snf -- ${quotedRelativeTarget} ${quotedLink}`,
    "",
    "  # 3. Keep the live file: copy it into the repository",
    `  cp -- ${quotedLink} ${quotedTarget}`,
    "  # Commit the repository change, then restore the link",
    `  rm -- ${quotedLink} && ln -snf -- ${quotedRelativeTarget} ${quotedLink}`,
    "",
    "Rip-cord — bypass this guard entirely for one launch (last resort):",
    "  KEEPER_AGENT_SKIP_LINK_GUARD=1 <your keeper agent command>",
  ].join("\n");
}

function unsupportedClobberMessage(linkPath: string, target: string): string {
  return [
    `Canonical Claude config path has an unsupported filesystem type: ${linkPath}`,
    `Expected a symlink to ${target} or a regular file that can be compared.`,
    "Keeper will not read, remove, or replace this path.",
    "",
    "Inspect it, move or remove it deliberately, then relaunch Keeper:",
    `  ls -ld -- ${shellQuote(linkPath)}`,
  ].join("\n");
}

/**
 * Non-throwing sibling of `divergentClobberMessage` for a warn-and-respect leaf
 * (Pi). Its global-instruction files are human-owned, so keeper never
 * clobbers a divergent regular file and — critically — never THROWS: main() maps
 * StateError → exit(1), so a throw here would abort a benign human-edited launch.
 * A single WARNING line the caller pushes onto the action log.
 */
function divergentRespectMessage(linkPath: string, target: string): string {
  return (
    `WARNING: ${linkPath} is a regular file whose contents differ from the shared ` +
    `source ${target}; leaving the live file in place (not re-linking). Remove it ` +
    `to let keeper re-assert the shared link on the next launch.`
  );
}

/**
 * Re-assert every canonical symlink in `leaves` on each launch — Claude's
 * repository-owned settings and global instructions plus Pi's shared global
 * instructions. A direct edit or atomic replacement can turn a link into a file.
 *
 * Per leaf (via lstat, so a clobber is never silently dereferenced):
 *   - correct symlink (resolves to the leaf's source) → no-op
 *   - symlink to the wrong target → repair + loud log
 *   - regular-file clobber, equivalent to the source → repair + loud log
 *     (`compare: "json"` ignores whitespace/key order; `"bytes"` is exact)
 *   - regular-file clobber, divergent contents → `onDivergence: "error"` throws
 *     StateError with recovery; `"warn"` leaves the live file + logs a WARNING
 *   - link absent but source present → create the relative link
 *   - source file missing → skip + warn (nothing to enforce against)
 *
 * `KEEPER_AGENT_SKIP_LINK_GUARD` set → skip the whole guard with a loud warning.
 * Throws a typed StateError only for an `error` leaf on divergence; main() owns the
 * exit. Leaves carry absolute `source`/`linkPath` (built by the per-harness leaf
 * helpers), so this function is HOME-agnostic.
 */
export function ensureCanonicalStowLinks(
  leaves: readonly CanonicalStowLeaf[],
  actionLog: string[] | null = null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.KEEPER_AGENT_SKIP_LINK_GUARD) {
    actionLog?.push(
      "WARNING: KEEPER_AGENT_SKIP_LINK_GUARD set — skipping canonical Claude " +
        "settings and harness global-instruction link enforcement",
    );
    return;
  }

  for (const leaf of leaves) {
    const target = leaf.source;
    const { linkPath } = leaf;
    const relTarget = relative(dirname(linkPath), target);

    if (!existsSync(target)) {
      actionLog?.push(
        `WARNING: stow source missing, cannot enforce canonical link: ${target}`,
      );
      continue;
    }

    if (isSymlink(linkPath)) {
      if (isSameSymlink(linkPath, target)) {
        continue;
      }
      relinkCanonical(linkPath, relTarget);
      actionLog?.push(
        `Repaired canonical stow link (wrong target): ${linkPath} -> ${relTarget}`,
      );
      continue;
    }

    if (!lexists(linkPath)) {
      relinkCanonical(linkPath, relTarget);
      actionLog?.push(
        `Created canonical stow link: ${linkPath} -> ${relTarget}`,
      );
      continue;
    }

    // Refuse directories, devices, sockets, and FIFOs before any blocking read.
    if (!lstatSync(linkPath).isFile()) {
      const message = unsupportedClobberMessage(linkPath, target);
      if (leaf.onDivergence === "error") {
        throw new StateError(message);
      }
      actionLog?.push(`WARNING: ${message}`);
      continue;
    }

    // Regular-file clobber: a direct edit or atomic write replaced the symlink.
    const live = readFileSync(linkPath, "utf8");
    const source = readFileSync(target, "utf8");
    const identical =
      leaf.compare === "json"
        ? jsonSemanticEqual(live, source)
        : live === source;
    if (!identical) {
      if (leaf.onDivergence === "error") {
        throw new StateError(
          divergentClobberMessage(linkPath, target, relTarget),
        );
      }
      // warn-and-respect: leave the human-owned file untouched, never throw.
      actionLog?.push(divergentRespectMessage(linkPath, target));
      continue;
    }
    relinkCanonical(linkPath, relTarget);
    actionLog?.push(
      `Repaired canonical stow link (identical clobber): ${linkPath} -> ${relTarget}`,
    );
  }
}

/**
 * Replace whatever sits at `linkPath` with a symlink storing the literal
 * `relTarget` (relative form, matching stow's output). ENOENT on unlink is
 * tolerated so concurrent launches racing the same path don't crash.
 */
function relinkCanonical(linkPath: string, relTarget: string): void {
  try {
    unlinkSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(relTarget, linkPath);
}

/**
 * Prepare Claude's canonical `~/.claude/` root before every Claude launch and
 * enforce both repository-owned symlinks. Equivalent clobbers self-heal;
 * divergent files remain untouched and fail loudly with recovery instructions.
 * Null source directories independently disable their leaf (test-only seams).
 */
export function ensureClaudeStateSharing(
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  claudeStowDir: string | null = null,
  sharedStowDir: string | null = null,
): void {
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  const leaves = claudeStowLeaves(claudeStowDir, sharedStowDir, homeDir);
  if (leaves.length > 0) {
    ensureCanonicalStowLinks(leaves, actionLog);
  }
}

/**
 * Materialize Pi's canonical `~/.pi/agent` root (plus its `sessions/` dir) and
 * re-assert its canonical `AGENTS.md` global-instruction leaf on every pi launch,
 * passthrough included. There is no Keeper-owned Pi profile farm: every pi launch
 * runs against this one canonical account. `sharedStowDir` null disables the
 * canonical AGENTS.md leaf (test-only fail-open).
 */
export function ensurePiStateSharing(
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  sharedStowDir: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const canonicalDir = join(homeDir, ".pi", "agent");
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(join(canonicalDir, "sessions"), { recursive: true });
  if (sharedStowDir !== null) {
    ensureCanonicalStowLinks(
      piCanonicalStowLeaves(sharedStowDir, canonicalDir),
      actionLog,
      env,
    );
  }
}
