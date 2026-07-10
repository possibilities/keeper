/**
 * Claude profile state sharing — the symlink farm that gives each named profile
 * dir (`~/.claude-profiles/<name>`) its own `.claude.json` (onboarding/theme/
 * trust) while sharing the bulk of state back to the canonical `~/.claude/`
 * root.
 *
 * Force-symlink helpers come in three flavors: a plain replace, a
 * directory-replacing replace, and a PRESERVING replace that migrates existing
 * files into the canonical target before linking (only `sessions/`, which holds
 * live per-PID sidecar JSONs that must never be wiped).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexHome } from "../codex-trust";

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

const REQUIRED_PROFILE_CLAUDE_JSON: Record<string, unknown> = {
  hasCompletedOnboarding: true,
  theme: "dark",
  lastReleaseNotesSeen: "9.9.99",
};

const PROFILE_TRUST_ENTRY: Record<string, unknown> = {
  allowedTools: [],
  isTrusted: true,
  hasTrustDialogAccepted: true,
};

export const DEFAULT_SHARED_PATHS: readonly string[] = [
  "CLAUDE.md",
  "settings.json",
  "settings.local.json",
  "keybindings.json",
  "agents",
  "skills",
  "history.jsonl",
  "projects",
  "plans",
  "tasks",
  "teams",
  "todos",
  "plugins",
  "sessions",
  "session-env",
  "shell-snapshots",
  "file-history",
  "paste-cache",
  "jobs",
  "session-monitor-state.json",
  "stats-cache.json",
  "mcp-needs-auth-cache.json",
];

export const DEFAULT_PI_SHARED_PATHS: readonly string[] = [
  "settings.json",
  "keybindings.json",
  "models.json",
  "trust.json",
  "sessions",
  "prompts",
  "skills",
  "themes",
  "extensions",
  "tools",
  "AGENTS.md",
  "APPEND_SYSTEM.md",
  "npm",
  "git",
  "bin",
];

// Shared paths that may hold real per-profile data we preserve into the
// canonical ~/.claude/ location instead of wipe-and-replace. These are runtime
// session-resource dirs; replacing them without migration can strand resume,
// history, shell snapshot, or paste metadata in a profile-local silo.
const PRESERVING_SHARED_PATHS: ReadonlySet<string> = new Set([
  "sessions",
  "session-env",
  "shell-snapshots",
  "file-history",
  "paste-cache",
  "jobs",
]);

const PI_PRESERVING_SHARED_PATHS: ReadonlySet<string> = new Set([
  "sessions",
  "prompts",
  "skills",
  "themes",
  "extensions",
  "tools",
  "npm",
  "git",
  "bin",
]);

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  return existsSync(path);
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

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
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

/**
 * Ensure `path` is a symlink to `target`. Returns true when a change was made.
 * Mirrors `_force_symlink`: a same-target symlink is a no-op; a dir-that-is-not-
 * a-symlink at `path` is an error (the farm never wipes a real directory here).
 */
export function forceSymlink(path: string, target: string): boolean {
  if (isSymlink(path)) {
    try {
      const current = resolveLinkTarget(path);
      if (current === target) {
        return false;
      }
    } catch {
      // Unreadable link — fall through to replace it.
    }
  }

  if (pathExists(path) || isSymlink(path)) {
    if (isDir(path) && !isSymlink(path)) {
      throw new StateError(`Symlink target path is a directory: ${path}`);
    }
    unlinkSync(path);
  }

  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return true;
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
 * must stay un-dereferenced: dereferencing would change farm comparison
 * semantics. This is `resolve()`, not `fs.realpathSync`.
 */
function normalizeAbsolute(p: string): string {
  return resolve(p);
}

/** Remove an existing file, symlink, or directory tree before linking. */
function removePathForSymlink(path: string): void {
  if (!pathExists(path) && !isSymlink(path)) {
    return;
  }
  if (isSymlink(path) || lstatSync(path).isFile()) {
    unlinkSync(path);
    return;
  }
  if (isDir(path)) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  throw new StateError(`Unsupported Claude config path type: ${path}`);
}

/** Ensure `path` is a symlink to `target`, replacing directories if needed. */
function forcePathSymlink(path: string, target: string): boolean {
  if (isSameSymlink(path, target)) {
    return false;
  }
  removePathForSymlink(path);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return true;
}

/**
 * Move every file from `source` into `target` before `source` is replaced.
 * Collisions (same filename at the destination) are left in place and logged —
 * the human resolves manually. Same-volume rename is atomic.
 */
function migrateDirContentsIntoTarget(
  source: string,
  target: string,
  actionLog: string[] | null,
): void {
  if (!pathExists(source) || isSymlink(source) || !isDir(source)) {
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of readdirSorted(source)) {
    const entry = join(source, name);
    const dest = join(target, name);
    if (lexists(dest)) {
      actionLog?.push(
        `Skipped migrating ${entry} -> ${dest}: destination exists`,
      );
      continue;
    }
    renameSync(entry, dest);
    actionLog?.push(`Migrated ${entry} -> ${dest}`);
  }
}

/** Like forcePathSymlink but migrates existing files into the target first. */
function forcePathSymlinkPreserving(
  path: string,
  target: string,
  actionLog: string[] | null,
): boolean {
  if (isSameSymlink(path, target)) {
    return false;
  }
  migrateDirContentsIntoTarget(path, target, actionLog);
  removePathForSymlink(path);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return true;
}

function readdirSorted(dir: string): string[] {
  // Sorted to match Python's sorted(iterdir()) ordering.
  return readdirSync(dir).sort();
}

/**
 * Force-merge onboarding/theme defaults (and optional trust entries) into the
 * profile `.claude.json`. Returns true when the file was changed. A corrupt or
 * missing JSON is treated as an empty object (rebuilt). Mirrors
 * `_ensure_profile_claude_json`.
 */
export function ensureProfileClaudeJson(
  profileDir: string,
  trustPaths: string[] | null = null,
  actionLog: string[] | null = null,
): boolean {
  const claudeJsonPath = join(profileDir, ".claude.json");
  if (pathExists(claudeJsonPath) && isDir(claudeJsonPath)) {
    throw new StateError(
      `Profile Claude state path is a directory: ${claudeJsonPath}`,
    );
  }

  let claudeJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    claudeJson = isRecord(parsed) ? parsed : {};
  } catch {
    claudeJson = {};
  }

  let changed = false;
  for (const [key, value] of Object.entries(REQUIRED_PROFILE_CLAUDE_JSON)) {
    if (!jsonEqual(claudeJson[key], value)) {
      claudeJson[key] = value;
      changed = true;
    }
  }

  let projects = claudeJson.projects;
  if (!isRecord(projects)) {
    projects = {};
    claudeJson.projects = projects;
    changed = true;
  }
  const projectsMap = projects as Record<string, unknown>;

  for (const trustPath of trustPaths ?? []) {
    const existing = projectsMap[trustPath];
    if (!isRecord(existing)) {
      projectsMap[trustPath] = { ...PROFILE_TRUST_ENTRY };
      changed = true;
      continue;
    }
    for (const [key, value] of Object.entries(PROFILE_TRUST_ENTRY)) {
      if (!jsonEqual(existing[key], value)) {
        existing[key] = value;
        changed = true;
      }
    }
  }

  if (!changed) {
    return false;
  }

  writeFileSync(claudeJsonPath, `${JSON.stringify(claudeJson, null, 2)}\n`);
  if (actionLog !== null) {
    let message = `Updated profile .claude.json onboarding/theme defaults: ${claudeJsonPath}`;
    if (trustPaths && trustPaths.length > 0) {
      message += ` (trusted ${trustPaths.length} path(s))`;
    }
    actionLog.push(message);
  }
  return true;
}

/**
 * Profile-dir basenames a launch may NEVER `mkdir` under `~/.claude-profiles`
 * / `~/.pi-profiles`. `""`/`default` collide with the native `~/.claude`
 * account — a `default` silo strands auth nothing reads; `auto` is the routing
 * sentinel. Mirror of RESERVED_PRESET_NAMES (config.ts), but profile-shaped.
 */
const RESERVED_PROFILE_DIR_NAMES: ReadonlySet<string> = new Set([
  "default",
  "auto",
]);

/** Allowlist for a profile-dir basename — aligned with PRESET_NAME_PATTERN. */
const PROFILE_DIR_NAME_PATTERN = /^[a-z0-9_-]+$/;

/** Max bytes for a single path component on the supported filesystems. */
const MAX_PROFILE_DIR_NAME_BYTES = 255;

/**
 * True iff `name` (trimmed + NFC-normalized) is a reserved profile-dir
 * basename — `""`/`default`/`auto`, the set that collides with the native
 * `~/.claude` / `~/.pi` account. The shared reserved-name knowledge the mkdir
 * guard and the read-only shadow detector both key off (so a `default`/`auto`
 * dir under a profiles root is ALWAYS a shadow).
 */
export function isReservedProfileDirName(name: string): boolean {
  const candidate = name.trim().normalize("NFC");
  return candidate === "" || RESERVED_PROFILE_DIR_NAMES.has(candidate);
}

/**
 * Fail-loud guard for every profile-dir `mkdir` site. Throws StateError (state
 * layer → exit 1, NOT ConfigError) for the reserved set (`""`/`default`/`auto`,
 * trimmed), path-escape (separator / `..` / NUL — checked atomically on the RAW
 * input BEFORE any normalization, since `path.normalize` silently collapses
 * `foo/../bar`→`bar`), an off-allowlist name, or an over-255-byte name. NFC is
 * for validation/comparison ONLY — the caller still mkdirs the ORIGINAL string
 * (macOS stores NFD; writing a normalized name then readdir mismatches). The
 * message carries the name + reason only — never the resolved absolute path.
 */
export function assertProfileDirNameAllowed(name: string): void {
  if (name.includes("\0")) {
    throw new StateError("Profile name must not contain a NUL byte.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new StateError(
      `Profile name '${name}' must not contain path separators or '..'.`,
    );
  }
  if (Buffer.byteLength(name, "utf8") > MAX_PROFILE_DIR_NAME_BYTES) {
    throw new StateError(
      `Profile name exceeds ${MAX_PROFILE_DIR_NAME_BYTES} bytes.`,
    );
  }
  if (isReservedProfileDirName(name)) {
    throw new StateError(
      `Profile name '${name.trim()}' is reserved and cannot be used.`,
    );
  }
  const candidate = name.trim().normalize("NFC");
  if (!PROFILE_DIR_NAME_PATTERN.test(candidate)) {
    throw new StateError(
      `Profile name '${name.trim()}' must match [a-z0-9_-]+.`,
    );
  }
}

/**
 * Create a named Claude config dir and link its `settings.json`/`CLAUDE.md` to
 * the canonical `~/.claude/` copies (stow-owned). Returns `[profileDir,
 * changed]`. `~/.claude/settings.json` MUST exist (fail-loud); `~/.claude/
 * CLAUDE.md` is linked only when it exists.
 */
export function ensureKeeperAgentProfileDir(
  profileName: string,
  trustPaths: string[] | null,
  actionLog: string[] | null,
  homeDir: string = homedir(),
): [string, boolean] {
  assertProfileDirNameAllowed(profileName);
  const sharedConfigDir = join(homeDir, ".claude");
  const sharedSettings = join(sharedConfigDir, "settings.json");
  const sharedClaudeMd = join(sharedConfigDir, "CLAUDE.md");
  const profileDir = join(homeDir, ".claude-profiles", profileName);
  const profileSettings = join(profileDir, "settings.json");
  const profileClaudeMd = join(profileDir, "CLAUDE.md");
  let changed = false;

  if ((pathExists(profileDir) || isSymlink(profileDir)) && !isDir(profileDir)) {
    throw new StateError(`Profile path is not a directory: ${profileDir}`);
  }

  if (!pathExists(profileDir) && !isSymlink(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
    changed = true;
    actionLog?.push(`Created profile directory: ${profileDir}`);
  }

  if (ensureProfileClaudeJson(profileDir, trustPaths, actionLog)) {
    changed = true;
  }

  if (!existsSync(sharedSettings)) {
    throw new StateError(
      `Claude settings not found: ${sharedSettings}. ` +
        "It ships via the `claude` stow package — run scripts/install.sh " +
        "(or restore the file) before launching.",
    );
  }

  if (forceSymlink(profileSettings, sharedSettings)) {
    changed = true;
    actionLog?.push(
      `Linked profile settings: ${profileSettings} -> ${sharedSettings}`,
    );
  }

  if (
    existsSync(sharedClaudeMd) &&
    forceSymlink(profileClaudeMd, sharedClaudeMd)
  ) {
    changed = true;
    actionLog?.push(
      `Linked profile CLAUDE.md: ${profileClaudeMd} -> ${sharedClaudeMd}`,
    );
  }

  if (
    ensureProfileSharedLinks(
      profileDir,
      sharedConfigDir,
      DEFAULT_SHARED_PATHS,
      actionLog,
    )
  ) {
    changed = true;
  }

  return [profileDir, changed];
}

/**
 * Create a named Pi agent dir and share non-auth state with the canonical
 * `~/.pi/agent` root. `auth.json` is intentionally left profile-local, while
 * settings, package resources, trust, and sessions link through to the native
 * Pi account so profile routing does not fragment history or installed tools.
 */
export function ensureKeeperAgentPiProfileDir(
  profileName: string,
  actionLog: string[] | null,
  homeDir: string = homedir(),
  sharedStowDir: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): [string, boolean] {
  assertProfileDirNameAllowed(profileName);
  const canonicalDir = join(homeDir, ".pi", "agent");
  const profileDir = join(homeDir, ".pi-profiles", profileName);
  let changed = false;

  ensurePiCanonicalRoot(canonicalDir, sharedStowDir, actionLog, env);

  if ((pathExists(profileDir) || isSymlink(profileDir)) && !isDir(profileDir)) {
    throw new StateError(`Pi profile path is not a directory: ${profileDir}`);
  }

  if (!pathExists(profileDir) && !isSymlink(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
    changed = true;
    actionLog?.push(`Created Pi profile directory: ${profileDir}`);
  }

  if (ensurePiProfileSharedLinks(profileDir, canonicalDir, actionLog)) {
    changed = true;
  }

  return [profileDir, changed];
}

function ensurePiCanonicalRoot(
  canonicalDir: string,
  sharedStowDir: string | null,
  actionLog: string[] | null,
  env: NodeJS.ProcessEnv,
): void {
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(join(canonicalDir, "sessions"), { recursive: true });
  // Materialize the canonical AGENTS.md leaf BEFORE any profile loop runs — the
  // per-profile shared-link loop skips a canonical path that does not yet exist,
  // so a late materialization would drop AGENTS.md for every profile. Null shared
  // dir disables it (test-only fail-open); production resolves a real path via
  // `defaultSharedStowDir()`.
  if (sharedStowDir !== null) {
    ensureCanonicalStowLinks(
      piCanonicalStowLeaves(sharedStowDir, canonicalDir),
      actionLog,
      env,
    );
  }
}

function ensurePiProfileSharedLinks(
  profileDir: string,
  canonicalDir: string,
  actionLog: string[] | null,
): boolean {
  let changed = false;
  for (const pathName of DEFAULT_PI_SHARED_PATHS) {
    const canonicalPath = join(canonicalDir, pathName);
    if (!pathExists(canonicalPath) && !isSymlink(canonicalPath)) {
      continue;
    }
    const profilePath = join(profileDir, pathName);
    const changedLink = PI_PRESERVING_SHARED_PATHS.has(pathName)
      ? forcePathSymlinkPreserving(profilePath, canonicalPath, actionLog)
      : forcePathSymlink(profilePath, canonicalPath);
    if (changedLink) {
      changed = true;
      actionLog?.push(
        `Linked shared Pi path: ${profilePath} -> ${canonicalPath}`,
      );
    }
  }
  return changed;
}

/** Ensure the configured shared paths point back to the canonical root. */
function ensureProfileSharedLinks(
  profileDir: string,
  canonicalDir: string,
  sharedPaths: readonly string[],
  actionLog: string[] | null,
): boolean {
  let changed = false;
  for (const pathName of sharedPaths) {
    const canonicalPath = join(canonicalDir, pathName);
    if (!pathExists(canonicalPath) && !isSymlink(canonicalPath)) {
      continue;
    }
    const profilePath = join(profileDir, pathName);
    const changedLink = PRESERVING_SHARED_PATHS.has(pathName)
      ? forcePathSymlinkPreserving(profilePath, canonicalPath, actionLog)
      : forcePathSymlink(profilePath, canonicalPath);
    if (changedLink) {
      changed = true;
      actionLog?.push(
        `Linked shared Claude path: ${profilePath} -> ${canonicalPath}`,
      );
    }
  }
  return changed;
}

function configuredNonDefaultProfiles(profiles: string[]): string[] {
  return profiles.filter((p) => normalizeProfile(p) !== "");
}

function normalizeProfile(profileName: string): string {
  const normalized = profileName.trim();
  return normalized === "default" ? "" : normalized;
}

/** How a canonical leaf's regular-file clobber is compared to its stow source:
 *  `json` is whitespace/key-order-insensitive (settings.json); `bytes` is exact. */
export type LeafCompare = "json" | "bytes";

/** What the guard does when a leaf's regular-file clobber diverges from its source:
 *  `error` hard-throws (keeper-owned leaves); `warn` leaves the live file in place
 *  and logs (human-owned global-instruction leaves — codex/pi). */
export type LeafDivergence = "error" | "warn";

/**
 * One canonical global-instruction leaf the launch guard re-asserts: a symlink at
 * `linkPath` that must resolve to the real stow `source`. Generalizes the former
 * claude-only `[settings.json, CLAUDE.md]` pair into a per-harness table so codex's
 * `AGENTS.md` and pi's canonical `AGENTS.md` re-link to keeper's one shared source
 * on every launch too. `compare` picks the clobber-equality test; `onDivergence`
 * picks the hard-error vs warn-and-respect split (a wrong-TARGET symlink is always
 * repaired regardless — that repair is the codex/pi cutover onto keeper).
 */
export interface CanonicalStowLeaf {
  source: string;
  linkPath: string;
  compare: LeafCompare;
  onDivergence: LeafDivergence;
}

/** The claude leaves: `settings.json` (json-compared, hard-error, sourced from the
 *  claude stow dir) + `CLAUDE.md` sourced from the ONE shared `AGENTS.md` (byte-
 *  compared, hard-error). Both keeper-owned, so a divergent clobber is fail-loud. */
function claudeStowLeaves(
  claudeStowDir: string,
  sharedStowDir: string,
  homeDir: string,
): CanonicalStowLeaf[] {
  const claudeDir = join(homeDir, ".claude");
  return [
    {
      source: join(claudeStowDir, "settings.json"),
      linkPath: join(claudeDir, "settings.json"),
      compare: "json",
      onDivergence: "error",
    },
    {
      source: join(sharedStowDir, "AGENTS.md"),
      linkPath: join(claudeDir, "CLAUDE.md"),
      compare: "bytes",
      onDivergence: "error",
    },
  ];
}

/** The codex leaf: `<CODEX_HOME|~/.codex>/AGENTS.md` sourced from the shared file,
 *  warn-and-respect (a human-edited codex AGENTS.md is never clobbered; only a
 *  wrong-target symlink is repaired, which cuts codex over onto keeper). */
function codexStowLeaves(
  sharedStowDir: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): CanonicalStowLeaf[] {
  return [
    {
      source: join(sharedStowDir, "AGENTS.md"),
      linkPath: join(resolveCodexHome(env, homeDir), "AGENTS.md"),
      compare: "bytes",
      onDivergence: "warn",
    },
  ];
}

/** The pi canonical leaf: `<canonicalDir>/AGENTS.md` sourced from the shared file,
 *  warn-and-respect. Materialized BEFORE the profile loop so per-profile AGENTS.md
 *  links are not skipped by the canonical-absent guard in the loop. */
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
  let pa: unknown;
  let pb: unknown;
  try {
    pa = JSON.parse(a);
    pb = JSON.parse(b);
  } catch {
    // One side is not valid JSON — fall back to the byte comparison above.
    return false;
  }
  return canonicalJson(pa) === canonicalJson(pb);
}

/** Serialize with object keys sorted recursively so key order can't differ. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function divergentClobberMessage(
  linkPath: string,
  target: string,
  relTarget: string,
): string {
  return [
    `Canonical Claude config drift: ${linkPath} is a regular file whose`,
    `contents differ from the stow source ${target}.`,
    "",
    "Claude Code's atomic-rename settings write clobbered the stow symlink and",
    "the live file has since diverged from the repo. keeper agent will not pick a",
    "winner for you. Resolve it one of these ways:",
    "",
    `  # 1. Inspect the difference`,
    `  diff -u ${target} ${linkPath}`,
    "",
    `  # 2. Discard the live file and restore the repo's version`,
    `  rm ${linkPath} && ( cd ${dirname(target)} && stow --restow -t ${join(linkPath, "..")} . ) \\`,
    `    || ln -snf ${relTarget} ${linkPath}`,
    "",
    `  # 3. Keep the live file: copy it into the repo, commit, then restore the link`,
    `  cp ${linkPath} ${target} && rm ${linkPath} && ln -snf ${relTarget} ${linkPath}`,
    "",
    "Rip-cord — bypass this guard entirely for one launch (last resort):",
    "  KEEPER_AGENT_SKIP_LINK_GUARD=1 <your keeper agent command>",
  ].join("\n");
}

/**
 * Non-throwing sibling of `divergentClobberMessage` for a warn-and-respect leaf
 * (codex / pi). Their global-instruction files are human-owned, so keeper never
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
 * Re-assert every canonical global-instruction symlink in `leaves` on each launch —
 * one keeper-owned `system/shared/AGENTS.md` behind claude's `~/.claude/CLAUDE.md`,
 * codex's `AGENTS.md`, and pi's canonical `AGENTS.md` (plus claude's `settings.json`
 * off the claude stow dir). An atomic-rename write (Claude Code) or a human edit can
 * replace a relative symlink with a regular file; this guard force-restores the link.
 *
 * Per leaf (via lstat, so a clobber is never silently dereferenced):
 *   - correct symlink (resolves to the leaf's source) → no-op
 *   - symlink to the wrong target → repair + loud log (the codex/pi cutover onto
 *     keeper's shared source, for EVERY leaf regardless of `onDivergence`)
 *   - regular-file clobber, contents identical to the source → repair + loud log
 *     (`compare: "json"` key-order-independent; `compare: "bytes"` exact)
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
      "WARNING: KEEPER_AGENT_SKIP_LINK_GUARD set — skipping the canonical stow " +
        "link guard; harness global-instruction links are NOT re-asserted",
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

    // Regular-file clobber: an atomic-rename write or a human edit replaced the
    // symlink with a real file.
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
 * Prepare runtime Claude state and enforce the shared-metadata symlinks across
 * every configured non-default profile dir, plus the `~/.claude-profiles/
 * default/` silo's session-bearing-path links back to canonical. `listProfilesFn`
 * is injected (agentusage's `listProfiles`) so this stays testable without the
 * real catalog. `claudeStowDir` (keeper's `system/claude/.claude`) drives the
 * launch-time canonical-link guard and sources `settings.json`; `sharedStowDir`
 * (keeper's `system/shared`) sources the `CLAUDE.md` leaf from the one shared
 * `AGENTS.md`. A null `claudeStowDir` disables the guard (test-only fail-open).
 */
export function ensureClaudeStateSharing(
  listProfilesFn: () => string[],
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  claudeStowDir: string | null = null,
  sharedStowDir: string | null = null,
): void {
  const profileNames = configuredNonDefaultProfiles(safeList(listProfilesFn));
  const sharedPaths = [...DEFAULT_SHARED_PATHS];

  const canonicalDir = join(homeDir, ".claude");
  mkdirSync(canonicalDir, { recursive: true });

  // Keeper owns `~/.claude/settings.json` (off `system/claude/.claude`) and
  // `~/.claude/CLAUDE.md` (off the shared `system/shared/AGENTS.md`) as relative
  // symlinks into the repo. This guard re-asserts those canonical links on every
  // launch (Claude's atomic-rename settings write clobbers them into regular
  // files) BEFORE the profile farm links through them, and hard-errors on a
  // genuinely divergent clobber. `settings.json`/`CLAUDE.md` also appear in
  // DEFAULT_SHARED_PATHS, so each profile links them through this freshly-correct
  // canonical node like every other shared path. A null `claudeStowDir` disables
  // the guard — test-only fail-open; production resolves real paths via
  // `defaultClaudeStowDir()` / `defaultSharedStowDir()`.
  if (claudeStowDir !== null) {
    const sharedDir = sharedStowDir ?? defaultSharedStowDir();
    ensureCanonicalStowLinks(
      claudeStowLeaves(claudeStowDir, sharedDir, homeDir),
      actionLog,
    );
  }

  const profilesRoot = join(homeDir, ".claude-profiles");

  // The native account uses ~/.claude/ directly, but ~/.claude-profiles/default/
  // is a leftover silo still accumulating writes for session-bearing paths.
  // Symlink those back to ~/.claude/ so --resume / history / plans / /rename all
  // see one unified view. `sessions/` routes through the preserving variant.
  const defaultProfileDir = join(profilesRoot, "default");
  if (isDir(defaultProfileDir) && !isSymlink(defaultProfileDir)) {
    for (const sharedName of [
      "projects",
      "history.jsonl",
      "plans",
      "sessions",
      "session-env",
      "shell-snapshots",
      "file-history",
      "paste-cache",
      "jobs",
    ]) {
      const linkPath = join(defaultProfileDir, sharedName);
      const target = join(canonicalDir, sharedName);
      if (!existsSync(target)) {
        continue;
      }
      let changedLink: boolean;
      if (PRESERVING_SHARED_PATHS.has(sharedName)) {
        changedLink = forcePathSymlinkPreserving(linkPath, target, actionLog);
      } else {
        changedLink = forcePathSymlink(linkPath, target);
      }
      if (changedLink) {
        actionLog?.push(`Linked shared Claude path: ${linkPath} -> ${target}`);
      }
    }
  }

  if (profileNames.length === 0) {
    return;
  }

  mkdirSync(profilesRoot, { recursive: true });
  for (const profileName of profileNames) {
    assertProfileDirNameAllowed(profileName);
    const profileDir = join(profilesRoot, profileName);
    if (
      (pathExists(profileDir) || isSymlink(profileDir)) &&
      !isDir(profileDir)
    ) {
      throw new StateError(`Profile path is not a directory: ${profileDir}`);
    }
    if (!pathExists(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
      actionLog?.push(`Created profile directory: ${profileDir}`);
    }
    ensureProfileClaudeJson(profileDir, null, actionLog);
    ensureProfileSharedLinks(profileDir, canonicalDir, sharedPaths, actionLog);
  }
}

/**
 * Re-assert codex's canonical global-instruction link on every launch (codex is
 * almost always a passthrough invocation, so this runs unconditionally to reach
 * ALL codex launches). codex reads `<CODEX_HOME|~/.codex>/AGENTS.md`; this points
 * that leaf at keeper's one shared `system/shared/AGENTS.md`. Warn-and-respect: a
 * human-edited regular file is left in place with a WARNING and NEVER throws (main()
 * maps StateError → exit 1, so a throw would abort a benign launch) — but a
 * wrong-TARGET symlink IS repaired, and that repair is the codex cutover onto
 * keeper. `sharedStowDir` null disables the guard (test-only fail-open); production
 * resolves a real path via `defaultSharedStowDir()`. keeper only READS CODEX_HOME
 * (via `resolveCodexHome`) — it never sets or forces it.
 */
export function ensureCodexStateSharing(
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  sharedStowDir: string | null = null,
): void {
  if (sharedStowDir === null) {
    return;
  }
  ensureCanonicalStowLinks(
    codexStowLeaves(sharedStowDir, homeDir, env),
    actionLog,
    env,
  );
}

/** Prepare Pi profile dirs for every configured non-default keeper agent profile.
 *  Always materializes the canonical `~/.pi/agent/AGENTS.md` leaf first (even with
 *  no configured profiles — main() calls this with an empty list on a passthrough
 *  launch so the default-account canonical leaf is covered too); the profile farm
 *  runs only when profiles are configured. `sharedStowDir` null disables the
 *  canonical AGENTS.md leaf (test-only fail-open). */
export function ensurePiStateSharing(
  listProfilesFn: () => string[],
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  sharedStowDir: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const profileNames = configuredNonDefaultProfiles(safeList(listProfilesFn));
  const canonicalDir = join(homeDir, ".pi", "agent");
  ensurePiCanonicalRoot(canonicalDir, sharedStowDir, actionLog, env);

  if (profileNames.length === 0) {
    return;
  }

  const profilesRoot = join(homeDir, ".pi-profiles");
  mkdirSync(profilesRoot, { recursive: true });
  for (const profileName of profileNames) {
    assertProfileDirNameAllowed(profileName);
    const profileDir = join(profilesRoot, profileName);
    if (
      (pathExists(profileDir) || isSymlink(profileDir)) &&
      !isDir(profileDir)
    ) {
      throw new StateError(`Pi profile path is not a directory: ${profileDir}`);
    }
    if (!pathExists(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
      actionLog?.push(`Created Pi profile directory: ${profileDir}`);
    }
    ensurePiProfileSharedLinks(profileDir, canonicalDir, actionLog);
  }
}

function safeList(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
