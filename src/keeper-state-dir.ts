/**
 * `~/.local/state/keeper/` — keeper's durable per-user STATE root, the sibling of
 * `keeperConfigDir()`'s `~/.config/keeper/` (src/agent/config.ts). Deliberately
 * NON-XDG: it is distinct from the XDG-honoring
 * `defaultKeeperAgentStateDir` / `keeper-agent` dir the tmux
 * launcher uses.
 *
 * `KEEPER_STATE_DIR` overrides it — the single env seam (the test-isolation lever,
 * since os.homedir() ignores $HOME on macOS, and a production override).
 *
 * Dep-free leaf: `node:*` only, never bun:sqlite — the durable panel state under
 * `<state-dir>/panels/` is filesystem-only, so `src/pair/panel.ts` can import this
 * without reaching the DB island.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The `~/.local/state/keeper/` base dir (or `KEEPER_STATE_DIR` when set). */
export function keeperStateDir(): string {
  const override = process.env.KEEPER_STATE_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper");
}
