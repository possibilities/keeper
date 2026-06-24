/**
 * Resolve the absolute path the detached tmux pane re-execs to reach the folded
 * launcher: `<bun> <abs cli/keeper.ts> agent <agent> …`. This is the cold-start /
 * pair variant — it MUST NOT import `src/db.ts` (the bun:sqlite module): pulling
 * the DB graph onto the launch path would re-drag the daemon onto a surface whose
 * only need is "where is keeper's CLI entry". The config-aware sibling lives in
 * `src/db.ts` as {@link resolveKeeperAgentPath}; it folds the `keeper_agent_path`
 * config key on top of the same env-override + default this leaf supplies.
 *
 * Why an EXPLICIT resolved path and not `process.argv[1]`: under keeper the live
 * `argv[1]` is `cli/keeper.ts` (CLI) or `src/daemon.ts` (keeperd) — neither
 * carries the `agent` token, and `daemon.ts` is the wrong binary entirely. The
 * detached pane's launch script `cd`s before re-exec'ing, and keeperd runs under
 * a stripped LaunchAgent PATH (no `~/.bun/bin`), so the embedded path must be
 * ABSOLUTE and symlink-resolved — a relative or PATH-relative token would either
 * miss after the `cd` or PATH-inject.
 *
 * Precedence: `KEEPER_AGENT_PATH` env > `KEEPER_AGENTWRAP_PATH` env (deprecated
 * alias, kept readable for the migration) > the derived default (this module's
 * own location → `../cli/keeper.ts`, `realpath`'d). The env overrides are
 * tilde-expanded AT RESOLVE TIME (`execvp`/the shell re-exec do not expand `~`).
 * No existence check — a bad path fails the launch loudly at spawn, not silently
 * here.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Derive the abs `cli/keeper.ts` path from this module's own location, then
 *  symlink-resolve it. `src/keeper-agent-path.ts` → `../cli/keeper.ts`. */
export function defaultKeeperAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, "..", "cli", "keeper.ts");
  try {
    return realpathSync(entry);
  } catch {
    // The file should always exist next to this module; if a symlink-resolve
    // fails (e.g. a partial install), fall back to the unresolved abs path
    // rather than throwing on a pure path computation.
    return entry;
  }
}

/** Tilde-expand an env-provided override at resolve time. */
function expandTilde(entry: string, home: string): string {
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/**
 * The `db.ts`-free resolver: env override > deprecated env alias > derived
 * default. `env`/`home` injectable for tests. Returns an absolute path
 * (tilde-expanded; an env override is taken as-given otherwise, so a caller that
 * needs it `realpath`'d should pass an already-resolved value — the DEFAULT is
 * always `realpath`'d).
 */
export function resolveKeeperAgentPathDepFree(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env.KEEPER_AGENT_PATH ?? env.KEEPER_AGENTWRAP_PATH;
  if (override && override.length > 0) {
    const expanded = expandTilde(override, home);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return defaultKeeperAgentPath();
}

/**
 * Build the launcher argv PREFIX the detached pane re-execs:
 * `[<bun>, <abs cli/keeper.ts>, "agent"]`. The pane's launch script appends the
 * agent token + inner args, yielding `<bun> <keeper.ts> agent <agent> <args…>`.
 * `bun` is `process.execPath` (an absolute path — survives the stripped PATH).
 */
export function buildLauncherArgvPrefix(
  bun: string,
  keeperAgentPath: string,
): string[] {
  return [bun, keeperAgentPath, "agent"];
}
