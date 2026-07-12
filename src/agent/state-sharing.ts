/**
 * Canonical global-instruction state sharing — the launch-time guard that keeps
 * each harness's shared instruction leaf (Claude's `CLAUDE.md`, Codex's and Pi's
 * `AGENTS.md`) symlinked back to keeper's one real `system/shared/AGENTS.md`
 * source, plus Claude's canonical `CLAUDE.md` and Pi's canonical account root.
 *
 * There is no Keeper-owned profile farm: claude-swap exclusively owns any
 * managed-account session directory, and Keeper neither discovers nor repairs
 * its private layout. Claude's `settings.json` is install-time-seeded ONLY —
 * created from the claude stow source the first time `~/.claude/settings.json`
 * is absent, never again after that: this module never compares, repairs,
 * rejects, or blocks a launch on its live drift.
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

/**
 * What the guard does when a leaf's regular-file clobber diverges from its source:
 * `error` hard-throws (keeper-owned leaves); `warn` leaves the live file in place
 * and logs (human-owned global-instruction leaves — codex/pi).
 */
export type LeafDivergence = "error" | "warn";

/**
 * One canonical global-instruction leaf the launch guard re-asserts: a symlink at
 * `linkPath` that must resolve to the real stow `source`. A per-harness row so
 * claude's `CLAUDE.md`, codex's `AGENTS.md`, and pi's canonical `AGENTS.md` all
 * re-link to keeper's one shared source on every launch. `onDivergence` picks the
 * hard-error vs warn-and-respect split (a wrong-TARGET symlink is always repaired
 * regardless — that repair is the codex/pi cutover onto keeper).
 */
export interface CanonicalStowLeaf {
  source: string;
  linkPath: string;
  onDivergence: LeafDivergence;
}

/** The claude leaf: `CLAUDE.md` sourced from the ONE shared `AGENTS.md`
 *  (keeper-owned, so a divergent clobber is fail-loud). Claude's `settings.json`
 *  is install-time-seeded only (the `claude` stow package) — never re-asserted or
 *  compared here, so a live drift after install never repairs, rejects, or blocks
 *  a launch. */
function claudeStowLeaves(
  sharedStowDir: string,
  homeDir: string,
): CanonicalStowLeaf[] {
  const claudeDir = join(homeDir, ".claude");
  return [
    {
      source: join(sharedStowDir, "AGENTS.md"),
      linkPath: join(claudeDir, "CLAUDE.md"),
      onDivergence: "error",
    },
  ];
}

/**
 * Seed `~/.claude/settings.json` from the repo's canonical claude stow source
 * ONLY when the path is entirely absent — install-time seeding, never
 * repeated. Once anything sits at that path (a symlink, a regular file,
 * matching or diverging content), this is a permanent no-op: unlike a
 * {@link CanonicalStowLeaf}, a settings.json clobber is never compared,
 * repaired, rejected, or launch-blocking — the live file may evolve freely
 * after the first seed, and claude-swap shares it unmodified into every
 * managed session.
 */
function ensureClaudeSettingsSeed(
  homeDir: string,
  claudeStowDir: string,
  actionLog: string[] | null,
): void {
  const claudeDir = join(homeDir, ".claude");
  const linkPath = join(claudeDir, "settings.json");
  if (lexists(linkPath)) {
    return;
  }
  const source = join(claudeStowDir, "settings.json");
  if (!existsSync(source)) {
    actionLog?.push(
      `WARNING: claude settings stow source missing, cannot seed: ${source}`,
    );
    return;
  }
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(relative(claudeDir, source), linkPath);
  actionLog?.push(`Seeded Claude settings: ${linkPath} -> ${source}`);
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
      onDivergence: "warn",
    },
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
      onDivergence: "warn",
    },
  ];
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
    "A direct edit replaced the stow symlink and the live file has since",
    "diverged from the repo. keeper agent will not pick a winner for you.",
    "Resolve it one of these ways:",
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
 * codex's `AGENTS.md`, and pi's canonical `AGENTS.md`. A direct edit can replace a
 * relative symlink with a regular file; this guard force-restores the link.
 *
 * Per leaf (via lstat, so a clobber is never silently dereferenced):
 *   - correct symlink (resolves to the leaf's source) → no-op
 *   - symlink to the wrong target → repair + loud log (the codex/pi cutover onto
 *     keeper's shared source, for EVERY leaf regardless of `onDivergence`)
 *   - regular-file clobber, contents identical to the source → repair + loud log
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

    // Regular-file clobber: a direct edit replaced the symlink with a real file.
    const live = readFileSync(linkPath, "utf8");
    const source = readFileSync(target, "utf8");
    const identical = live === source;
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
 * Prepare Claude's canonical `~/.claude/` root on every claude launch: seed
 * `settings.json` from the claude stow source ONLY when absent (install-time
 * seeding — see {@link ensureClaudeSettingsSeed}; never compared, repaired, or
 * launch-blocking once it exists), then re-assert the `CLAUDE.md`
 * global-instruction link against the one shared source (always enforced,
 * fail-loud on a genuine divergence — see {@link ensureCanonicalStowLinks}).
 * A null `claudeStowDir` / `sharedStowDir` independently disables its half of
 * the guard (test-only fail-open); production resolves real paths via
 * `defaultClaudeStowDir()` / `defaultSharedStowDir()`.
 */
export function ensureClaudeStateSharing(
  actionLog: string[] | null = null,
  homeDir: string = homedir(),
  claudeStowDir: string | null = null,
  sharedStowDir: string | null = null,
): void {
  const canonicalDir = join(homeDir, ".claude");
  mkdirSync(canonicalDir, { recursive: true });

  if (claudeStowDir !== null) {
    ensureClaudeSettingsSeed(homeDir, claudeStowDir, actionLog);
  }

  if (sharedStowDir !== null) {
    ensureCanonicalStowLinks(
      claudeStowLeaves(sharedStowDir, homeDir),
      actionLog,
    );
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
