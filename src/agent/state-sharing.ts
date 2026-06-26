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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Raised for fail-loud state errors; main() prints `Error: <msg>` + exit 1. */
export class StateError extends Error {}

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
  "SYSTEM.md",
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
 * Create a named Claude config dir and link its `settings.json`/`CLAUDE.md` to
 * the canonical `~/.claude/` copies (stow-owned). Returns `[profileDir,
 * changed]`. `~/.claude/settings.json` MUST exist (fail-loud); `~/.claude/
 * CLAUDE.md` is linked only when it exists.
 */
export function ensureAgentwrapProfileDir(
  profileName: string,
  trustPaths: string[] | null,
  actionLog: string[] | null,
  homeDir: string = homedir(),
): [string, boolean] {
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
export function ensureAgentwrapPiProfileDir(
  profileName: string,
  actionLog: string[] | null,
  homeDir: string = homedir(),
): [string, boolean] {
  const canonicalDir = join(homeDir, ".pi", "agent");
  const profileDir = join(homeDir, ".pi-profiles", profileName);
  let changed = false;

  ensurePiCanonicalRoot(canonicalDir);

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

function ensurePiCanonicalRoot(canonicalDir: string): void {
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(join(canonicalDir, "sessions"), { recursive: true });
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

/**
 * The canonical stow-owned leaves the launch guard re-asserts. HARDCODED — NOT
 * derived from DEFAULT_SHARED_PATHS, which includes the gitignored
 * `settings.local.json` (per-machine overrides the stow package does not own).
 */
const CANONICAL_STOW_LEAVES: readonly string[] = ["settings.json", "CLAUDE.md"];

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
    "the live file has since diverged from the repo. agentwrap will not pick a",
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
    "  AGENTWRAP_SKIP_LINK_GUARD=1 <your agentwrap command>",
  ].join("\n");
}

/**
 * Re-assert the canonical stow-owned `~/.claude/{settings.json,CLAUDE.md}`
 * symlinks on every launch. Claude Code's atomic-rename settings write replaces
 * the relative stow symlink with a regular file; this guard force-restores the
 * relative link, hard-erroring only on a genuinely divergent clobber.
 *
 * Per leaf (via lstat, so a clobber is never silently dereferenced):
 *   - correct symlink (resolves to the stow target) → no-op
 *   - symlink to the wrong target → repair + loud log
 *   - regular-file clobber, contents identical to the source → repair + loud log
 *     (settings.json compared key-order-independently; CLAUDE.md byte-compared)
 *   - regular-file clobber, divergent contents → throw StateError with recovery
 *   - link absent but source present → create the relative link
 *   - source file missing → skip + warn (nothing to enforce against)
 *
 * `AGENTWRAP_SKIP_LINK_GUARD` set → skip the whole guard with a loud warning.
 * Throws a typed StateError on divergence; main() owns the exit.
 */
export function ensureCanonicalStowLinks(
  claudeStowDir: string,
  homeDir: string = homedir(),
  actionLog: string[] | null = null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.AGENTWRAP_SKIP_LINK_GUARD) {
    actionLog?.push(
      "WARNING: AGENTWRAP_SKIP_LINK_GUARD set — skipping the canonical stow " +
        "link guard; ~/.claude/{settings.json,CLAUDE.md} are NOT re-asserted",
    );
    return;
  }

  const claudeDir = join(homeDir, ".claude");
  for (const leaf of CANONICAL_STOW_LEAVES) {
    const target = join(claudeStowDir, leaf);
    const linkPath = join(claudeDir, leaf);
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

    // Regular-file clobber: Claude replaced the symlink with a real file.
    const live = readFileSync(linkPath, "utf8");
    const source = readFileSync(target, "utf8");
    const identical =
      leaf === "settings.json"
        ? jsonSemanticEqual(live, source)
        : live === source;
    if (!identical) {
      throw new StateError(
        divergentClobberMessage(linkPath, target, relTarget),
      );
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
 * real catalog. `claudeStowDir` (from `claude.yaml`) drives the launch-time
 * canonical-link guard; null disables it (fail-open).
 */
export function ensureClaudeStateSharing(
  listProfilesFn: () => string[],
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  claudeStowDir: string | null = null,
): void {
  const profileNames = configuredNonDefaultProfiles(safeList(listProfilesFn));
  const sharedPaths = [...DEFAULT_SHARED_PATHS];

  const canonicalDir = join(homeDir, ".claude");
  mkdirSync(canonicalDir, { recursive: true });

  // The `claude` stow package owns `~/.claude/{settings.json,CLAUDE.md}` as
  // relative symlinks into the repo. This guard re-asserts those canonical links
  // on every launch (Claude's atomic-rename settings write clobbers them into
  // regular files) BEFORE the profile farm links through them, and hard-errors
  // on a genuinely divergent clobber. `settings.json`/`CLAUDE.md` also appear in
  // DEFAULT_SHARED_PATHS, so each profile links them through this freshly-correct
  // canonical node like every other shared path. A null `claudeStowDir` (key
  // absent from claude.yaml) disables the guard — fail-open.
  if (claudeStowDir !== null) {
    ensureCanonicalStowLinks(claudeStowDir, homeDir, actionLog);
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

/** Prepare Pi profile dirs for every configured non-default agentwrap profile. */
export function ensurePiStateSharing(
  listProfilesFn: () => string[],
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
): void {
  const profileNames = configuredNonDefaultProfiles(safeList(listProfilesFn));
  const canonicalDir = join(homeDir, ".pi", "agent");
  ensurePiCanonicalRoot(canonicalDir);

  if (profileNames.length === 0) {
    return;
  }

  const profilesRoot = join(homeDir, ".pi-profiles");
  mkdirSync(profilesRoot, { recursive: true });
  for (const profileName of profileNames) {
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
