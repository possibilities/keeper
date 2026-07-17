/**
 * `keeper agent` — the in-binary agent-launch surface: `keeper agent
 * <claude|pi> [args...]` launches a supported agent CLI with keeper agent
 * routing + startup defaults, and `keeper agent wait-for-stop <handle>` /
 * `keeper agent show-last-message <handle>` read a detached run's transcript.
 * A caller-supplied launch handle is surface-scoped: it is the dedup key, resumes
 * a dead target, and refuses a live target in favor of the Agent Bus. Partner
 * names are host-global among tracked jobs; handoff slugs are host-global,
 * event-sourced, and reject duplicates with exit 3; panel slugs are only
 * display/discovery metadata, while the opaque panel request identity owns the
 * run. The blocking run-and-capture verbs compose those primitives into the
 * uniform schema-versioned JSON envelope: `keeper agent run <cli> <prompt>`
 * launches, waits, and captures in one process, and `keeper agent wait <handle>`
 * does the wait + capture on an already-launched handle. `keeper agent panel
 * start|wait|status|prune` fans a question out to a panel of detached read-only
 * run legs and waits for them token-free (routed into `src/pair/panel.ts`
 * `runPanel`, which owns its stdout + exit code); re-issuing `start` reconciles
 * the existing opaque request rather than re-fanning-out, `wait`/`status` locate
 * it by display slug or `--run-dir`, and `prune` GCs abandoned run dirs. `run
 * --read-only` prepends a
 * read-only directive to the prompt (prompting-only — keeper enforces nothing,
 * no tool strip, no changed-files audit); `run --system-file <path>`/`--system
 * <text>` prepend a caller-side `System:` block (mutually exclusive, uniform
 * across harnesses — user-turn text, not a privileged system prompt); Pi
 * launches with `CLAUDE*` env stripped by default (partner isolation). `run
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

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  KEEPER_AGENT_HELP,
  KEEPER_AGENT_RUNBOOK,
  splitSubcommand,
  USAGE,
  VERSION,
} from "../src/agent/dispatch";
import {
  main as launcherMain,
  type MainDeps,
  realDeps,
} from "../src/agent/main";
import { recordedProcessIdentity } from "../src/commit-work/process-identity";

export type TerminableHarness = "claude" | "pi";

export interface TerminableSession {
  jobId: string;
  state: string | null;
  harness: TerminableHarness;
  pid: number | null;
  startTime: string | null;
}

export interface TerminationProcessObservation {
  identity: "matching" | "gone" | "inconclusive";
  command: string | null;
}

export type SessionTerminationResult =
  | { ok: true; signal: "SIGTERM" | "SIGKILL"; exited: boolean }
  | {
      ok: false;
      reason:
        | "working"
        | "identity_unproven"
        | "command_unowned"
        | "signal_failed";
    };

export interface SessionTerminationDeps {
  probe(pid: number, startTime: string): TerminationProcessObservation;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  termGraceMs?: number;
  pollMs?: number;
}

/** Match a direct harness executable or its bounded node/bun launcher form. */
export function isHarnessProcessCommand(
  command: string,
  harness: TerminableHarness,
): boolean {
  const argv = command.includes("\0")
    ? command.split("\0").filter(Boolean)
    : command.trim().split(/\s+/).filter(Boolean);
  if (basename(argv[0] ?? "") === harness) return true;
  const launcher = basename(argv[0] ?? "");
  if (!new Set(["env", "node", "nodejs", "bun"]).has(launcher)) return false;
  const bounded = argv.slice(1, 4);
  if (bounded.some((token) => basename(token) === harness)) return true;
  const packageMarker =
    harness === "pi" ? "/pi-coding-agent/" : "/claude-code/";
  return bounded.some((token) => token.includes(packageMarker));
}

function productionTerminationProbe(
  pid: number,
  startTime: string,
): TerminationProcessObservation {
  const identity = recordedProcessIdentity(pid, startTime);
  if (identity !== "matching") return { identity, command: null };
  try {
    if (process.platform === "linux") {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const finalIdentity = recordedProcessIdentity(pid, startTime);
      return {
        identity: finalIdentity,
        command: finalIdentity === "matching" ? command : null,
      };
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["/bin/ps", "-ww", "-p", String(pid), "-o", "args="],
        { timeout: 500, stdout: "pipe", stderr: "ignore" },
      );
      if (!result.success || result.exitCode !== 0) {
        return { identity: "inconclusive", command: null };
      }
      const command = result.stdout.toString();
      const finalIdentity = recordedProcessIdentity(pid, startTime);
      return {
        identity: finalIdentity,
        command: finalIdentity === "matching" ? command : null,
      };
    }
  } catch {
    return { identity: "inconclusive", command: null };
  }
  return { identity: "inconclusive", command: null };
}

export const realSessionTerminationDeps: SessionTerminationDeps = {
  probe: productionTerminationProbe,
  signal: (pid, signal) => process.kill(pid, signal),
  nowMs: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

function confirmedTerminationTarget(
  observation: TerminationProcessObservation,
  harness: TerminableHarness,
): "confirmed" | "gone" | "identity_unproven" | "command_unowned" {
  if (observation.identity === "gone") return "gone";
  if (observation.identity !== "matching") return "identity_unproven";
  if (
    observation.command === null ||
    !isHarnessProcessCommand(observation.command, harness)
  ) {
    return "command_unowned";
  }
  return "confirmed";
}

/** Identity-rechecked process-only TERM-then-KILL ladder for one tracked Session. */
export async function terminateSessionProcess(
  session: TerminableSession,
  deps: SessionTerminationDeps = realSessionTerminationDeps,
): Promise<SessionTerminationResult> {
  if (session.state === "working") return { ok: false, reason: "working" };
  if (
    typeof session.state !== "string" ||
    session.state.length === 0 ||
    session.pid === null ||
    !Number.isSafeInteger(session.pid) ||
    session.pid <= 1 ||
    session.startTime === null ||
    session.startTime.length === 0
  ) {
    return { ok: false, reason: "identity_unproven" };
  }
  const pid = session.pid;
  const startTime = session.startTime;
  const first = confirmedTerminationTarget(
    deps.probe(pid, startTime),
    session.harness,
  );
  if (first === "gone") {
    return { ok: true, signal: "SIGTERM", exited: true };
  }
  if (first !== "confirmed") return { ok: false, reason: first };
  try {
    deps.signal(pid, "SIGTERM");
  } catch {
    return { ok: false, reason: "signal_failed" };
  }

  const deadline = deps.nowMs() + (deps.termGraceMs ?? 2_000);
  const pollMs = deps.pollMs ?? 50;
  while (deps.nowMs() < deadline) {
    await deps.sleep(Math.min(pollMs, Math.max(0, deadline - deps.nowMs())));
    const current = confirmedTerminationTarget(
      deps.probe(pid, startTime),
      session.harness,
    );
    if (current === "gone") {
      return { ok: true, signal: "SIGTERM", exited: true };
    }
    if (current !== "confirmed") {
      return {
        ok: false,
        reason:
          current === "command_unowned"
            ? "command_unowned"
            : "identity_unproven",
      };
    }
  }

  // The final probe is deliberately adjacent to SIGKILL; a recycled pid or
  // changed command after TERM never inherits kill authority.
  const final = confirmedTerminationTarget(
    deps.probe(pid, startTime),
    session.harness,
  );
  if (final === "gone") {
    return { ok: true, signal: "SIGTERM", exited: true };
  }
  if (final !== "confirmed") return { ok: false, reason: final };
  try {
    deps.signal(pid, "SIGKILL");
    return { ok: true, signal: "SIGKILL", exited: false };
  } catch {
    return { ok: false, reason: "signal_failed" };
  }
}

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
 * Route the pure meta modes — top-level help, version, the leading wrapper-help
 * (`--x-help`), and the operator runbook (`--agent-help`) — that render from static
 * text alone, returning true when handled. These MUST short-circuit before
 * {@link realDeps}, which runs the launcher state-dir migration: `keeper agent
 * --help`/`--version`/`--agent-help` touch no state dir, db, or daemon, so the argv
 * intent is classified BEFORE any dependency is built. `splitSubcommand` is pure
 * (db.ts stays off this path).
 */
export function routeMetaBeforeDeps(
  argv: string[],
  write: (s: string) => void,
): boolean {
  switch (splitSubcommand(argv).kind) {
    case "help":
      write(USAGE);
      return true;
    case "version":
      write(VERSION);
      return true;
    case "help-wrapper":
      write(KEEPER_AGENT_HELP);
      return true;
    case "agent-help":
      write(KEEPER_AGENT_RUNBOOK);
      return true;
    default:
      return false;
  }
}

/**
 * Subcommand entry. `cli/keeper.ts` routes `keeper agent <rest...>` here with
 * `argv` already stripped of the `agent` token; help/version short-circuit
 * before deps (see {@link routeMetaBeforeDeps}), and every launch path builds
 * the production deps and hands to the launcher, whose own `splitSubcommand`
 * pre-pass then classifies the leading agent/verb token. `buildDeps` is a seam
 * so a test can prove the meta path never constructs deps.
 */
export async function main(
  argv: string[],
  buildDeps: () => MainDeps = realDeps,
): Promise<void> {
  if (routeMetaBeforeDeps(argv, (s) => process.stdout.write(s))) {
    process.exit(0);
  }
  const deps = { ...buildDeps(), argv };
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
