/**
 * `keeper agent` — the in-binary agent-launch surface: `keeper agent
 * <claude|codex|pi> [args...]` launches a supported agent CLI with keeper agent
 * routing + startup defaults, and `keeper agent wait-for-stop <handle>` /
 * `keeper agent show-last-message <handle>` read a detached run's transcript.
 * The blocking run-and-capture verbs compose those primitives into the uniform
 * schema-versioned JSON envelope: `keeper agent run <cli> <prompt>` launches,
 * waits, and captures in one process, and `keeper agent wait <handle>` does the
 * wait + capture on an already-launched handle. `keeper agent panel
 * start|wait|status|prune` fans a question out to a panel of detached read-only
 * run legs and waits for them token-free (routed into `src/pair/panel.ts`
 * `runPanel`, which owns its stdout + exit code); `start` is idempotent by slug
 * (re-issuing RECONCILES the durable per-slug run instead of re-fanning-out),
 * `wait`/`status` address a run by `--slug` or `--run-dir`, and `prune` GCs abandoned
 * run dirs. `run
 * --read-only` prepends a
 * read-only directive to the prompt (prompting-only — keeper enforces nothing,
 * no tool strip, no changed-files audit); `run --system-file <path>`/`--system
 * <text>` prepend a caller-side `System:` block (mutually exclusive, uniform
 * across harnesses — user-turn text, not a privileged system prompt); codex/pi
 * launch with `CLAUDE*` env stripped by default (partner isolation). `run
 * --preset <name>` applies a launch-config preset (its resolved harness must
 * equal `<cli>`, else `bad_args`); `run --session <name>` names the tmux session
 * grouping (rides as `--x-tmux-session`, not the transcript id); `run --output
 * <path>` atomically writes the SAME envelope to a file (temp+rename) on every
 * outcome, an additional sink for detached-leg pollers beyond stdout.
 *
 * Named launch-config presets (harness/model/effort) live in the catalog
 * `~/.config/keeper/presets.yaml` (panel selections in `panel.yaml`): `keeper
 * agent --x-preset <name> [args...]` applies one — REQUIRED, an unknown name or
 * missing catalog exits 2 (the harness comes from the preset when no agent token
 * is given). `keeper agent presets list [--json]` enumerates the configured
 * presets + panels, and `keeper agent presets resolve <name>` emits the resolved
 * preset/panel JSON. A preset supplies defaults BELOW any explicit
 * `--model`/`--effort` or effort env, so with no preset behavior is unchanged.
 *
 * The thin process boundary: build the production deps and hand off to
 * `main()`, whose subcommand-dispatch pre-pass
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
