import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve a sitter's PRIVATE state dir: `<root>/<slug>`, where `<root>` is the
 * `BABYSITTER_STATE_DIR` env override (tests / sandboxes point it at a tmpdir)
 * or the default `~/.local/state/babysitters`.
 *
 * Every sitter (performance, git-orphans, dead-letters, …) namespaces its own
 * bookkeeping under its slug via this ONE helper — its OWN tree, deliberately
 * NOT under any `KEEPER_*` state dir, so a keeper.db re-fold never observes a
 * sitter's bookkeeping. Pure (no I/O); mirrors `resolveDbPath`'s resolver shape.
 */
export function babysitterStateDir(slug: string): string {
  const override = process.env.BABYSITTER_STATE_DIR;
  const root =
    override && override.length > 0
      ? override
      : join(homedir(), ".local", "state", "babysitters");
  return join(root, slug);
}
