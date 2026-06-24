/**
 * `keeper agent` — the folded agentwrap launcher. This is the in-binary launch
 * surface that supersedes the external `agentwrap` binary: `keeper agent
 * <claude|codex|pi> [args...]` launches a supported agent CLI with agentwrap
 * routing + startup defaults, and `keeper agent wait-for-stop <handle>` /
 * `keeper agent show-last-message <handle>` read a detached run's transcript.
 *
 * Named launch-config presets (harness/model/effort) live in a single registry,
 * `~/.config/agentwrap/presets.yaml`: `keeper agent --agentwrap-preset <name>
 * [args...]` applies one (the harness comes from the preset when no agent token
 * is given), and `keeper agent presets resolve <name>` emits the resolved
 * preset/panel JSON. A preset supplies defaults BELOW any explicit
 * `--model`/`--effort` or effort env, so with no preset behavior is unchanged.
 *
 * Mirrors the thin `bin/agentwrap.ts` process boundary: build the production
 * deps and hand off to `main()`, whose subcommand-dispatch pre-pass
 * (`src/agent/dispatch.ts` `splitSubcommand`) strips the leading agent token so
 * the composed agent argv stays byte-identical to what the bare launcher
 * produced. Policy lives in `src/agent/`; this file is the argv → main → exit
 * boundary plus one top-level error boundary — a missing agent binary fails
 * friendly, every other throw re-raises with its stack.
 *
 * The lazy `import("./agent")` from `cli/keeper.ts` keeps cold-start cheap and
 * MUST NOT transitively pull `src/db.ts` (the bun:sqlite module) onto the
 * `keeper plan` / `keeper status` common path — the launcher has no daemon
 * dependency.
 */

import { main as launcherMain, realDeps } from "../src/agent/main";

/** Bun 1.3 throws this shape when posix_spawn cannot resolve the target. */
function isSpawnNotFound(err: unknown): err is { path: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT" &&
    typeof (err as { path?: unknown }).path === "string"
  );
}

/**
 * Subcommand entry. `cli/keeper.ts` routes `keeper agent <rest...>` here with
 * `argv` already stripped of the `agent` token; the launcher's own
 * `splitSubcommand` pre-pass then classifies the leading agent/verb token.
 */
export async function main(argv: string[]): Promise<void> {
  const deps = { ...realDeps(), argv };
  await launcherMain(deps).catch((err: unknown) => {
    if (isSpawnNotFound(err)) {
      process.stderr.write(
        `Error: agent binary not found: ${err.path}. ` +
          "Install the requested agent CLI before launching.\n",
      );
      process.exit(1);
    }
    throw err;
  });
}
