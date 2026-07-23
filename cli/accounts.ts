#!/usr/bin/env bun

/**
 * `keeper accounts <inspect>` — the top-level, read-only routing-diagnostics
 * group. `inspect` is the sole verb today; the group shape leaves room for a
 * future sibling without minting another top-level command. Delegates to the
 * leaf's own logic in this file; an unknown verb is an argument fault (exit 2).
 *
 * `inspect` reuses the exact same reservation-free inspectors `keeper agent
 * accounts check` already calls (`inspectRouting` for Claude launch routing,
 * `productionCodexSessionInspection` for Codex launch-seed routing) — a shared
 * seam, so this command can never drift from that compatibility surface — and
 * adds a THIRD block neither of those carries: the scoped PROVEN Pi runtime
 * route for one ambient-or-explicit Session (never a high-cardinality dump of
 * every tracked Session's route).
 */

import {
  inspectRouting,
  type RoutingInspection,
} from "../src/account-router.ts";
import {
  type CodexSessionRoutingInspection,
  productionCodexSessionInspection,
} from "../src/agent/main.ts";
import type { CodexQuotaScope } from "../src/codex-quota-scope.ts";
import { resolveSessionId } from "../src/commit-work/session-id.ts";
import {
  type PiRouteObservation,
  type RuntimeTarget,
  readLatestPiRouteObservation,
  resolveSessionRuntimeDir,
} from "../src/session-runtime.ts";
import {
  type EnvelopeSink,
  emitEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope.ts";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference.ts";

export const ACCOUNTS_INSPECT_SCHEMA_VERSION = 1;

/**
 * `no_session` — no positional, `--session`, or ambient identity resolved at
 * all (the common operator-shell case; NOT an error).
 * `session_unresolved` — a reference resolved (explicit or ambient) but the
 * shared Session catalog could not match it; `reason` carries the bounded
 * `trackedSessionProblem` code.
 * `not_pi` — the matched Session is a Claude job; Codex Pi routing never
 * applies.
 * `unavailable` — a Pi Session with no fresh scoped route observation yet.
 * `proven` — a fresh scoped route observation for exactly this Session.
 */
export type AccountsPiRuntimeStatus =
  | "no_session"
  | "session_unresolved"
  | "not_pi"
  | "unavailable"
  | "proven";

export interface AccountsPiRuntimeData {
  status: AccountsPiRuntimeStatus;
  job_id: string | null;
  reason: string | null;
  quota_scope: CodexQuotaScope | null;
  state: "selected" | "retired" | null;
  alias: string | null;
  observed_at_ms: number | null;
}

export interface AccountsInspectData {
  generated_at_ms: number;
  claude_launch: RoutingInspection;
  codex_launch: CodexSessionRoutingInspection;
  pi_runtime: AccountsPiRuntimeData;
}

const INSPECT_HELP = `keeper accounts inspect [<session-reference>]

Emit separate schema-v1 Claude launch-routing, Codex launch-seed routing, and
scoped Pi runtime diagnostics — reservation-free and side-effect-free, JSON
always. With no Session (no positional, --session, or ambient identity),
pi_runtime reports "no_session" rather than every tracked Session's route.

Options:
  --session <ref>       Shared Session reference (alternative to positional)
  --session-id <ref>    Compatibility alias of --session
  --json                Accepted for command-line symmetry; output is always JSON
  --help, -h            Show this help
`;

interface ParsedInspectArgs {
  reference: string | null;
  help: boolean;
}

function inspectUsageFault(message: string): never {
  process.stderr.write(`${INSPECT_HELP}\n${message}\n`);
  process.exit(2);
}

function parseInspectArgs(argv: string[]): ParsedInspectArgs {
  let reference: string | null = null;
  let help = false;
  const setReference = (value: string | undefined): void => {
    if (value === undefined || value === "")
      inspectUsageFault("Expected a Session reference.");
    if (reference !== null)
      inspectUsageFault("Specify the Session reference only once.");
    reference = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      // Accepted for symmetry with `accounts check`; output is always JSON.
    } else if (arg === "--session" || arg === "--session-id") {
      setReference(argv[++index]);
    } else if (
      arg.startsWith("--session=") ||
      arg.startsWith("--session-id=")
    ) {
      setReference(arg.slice(arg.indexOf("=") + 1));
    } else if (!arg.startsWith("-")) {
      setReference(arg);
    } else {
      inspectUsageFault(`Unexpected argument '${arg}'.`);
    }
  }
  return { reference, help };
}

export interface AccountsInspectMainDeps extends SessionReferenceCliDeps {
  now?: () => number;
  runtimeDir?: string;
  inspectClaudeLaunchFn?: () => RoutingInspection;
  inspectCodexLaunchFn?: (
    env: NodeJS.ProcessEnv,
  ) => CodexSessionRoutingInspection;
  readRouteFn?: (
    target: RuntimeTarget,
    runtimeDir: string,
  ) => PiRouteObservation | null;
}

function unavailablePiRuntime(
  status: Exclude<AccountsPiRuntimeStatus, "proven">,
  jobId: string | null,
  reason: string | null = null,
): AccountsPiRuntimeData {
  return {
    status,
    job_id: jobId,
    reason,
    quota_scope: null,
    state: null,
    alias: null,
    observed_at_ms: null,
  };
}

function resolvePiRuntimeBlock(
  reference: string | null,
  deps: AccountsInspectMainDeps,
): AccountsPiRuntimeData {
  const env = deps.env ?? process.env;
  const target = reference ?? resolveSessionId(null, env);
  if (target === null) return unavailablePiRuntime("no_session", null);
  const resolution = resolveTrackedCliSession(target, deps);
  if (resolution.kind !== "resolved") {
    return unavailablePiRuntime(
      "session_unresolved",
      null,
      trackedSessionProblem(resolution).code,
    );
  }
  if (resolution.job.harness !== "pi") {
    return unavailablePiRuntime("not_pi", resolution.job.jobId);
  }
  const runtimeTarget: RuntimeTarget = {
    jobId: resolution.job.jobId,
    harness: "pi",
    nativeSessionId: resolution.job.nativeId,
  };
  const runtimeDir = deps.runtimeDir ?? resolveSessionRuntimeDir(env);
  const route = (deps.readRouteFn ?? readLatestPiRouteObservation)(
    runtimeTarget,
    runtimeDir,
  );
  if (route === null) {
    return unavailablePiRuntime("unavailable", runtimeTarget.jobId);
  }
  return {
    status: "proven",
    job_id: runtimeTarget.jobId,
    reason: null,
    quota_scope: route.quota_scope,
    state: route.state,
    alias: route.alias,
    observed_at_ms: route.observed_at_ms,
  };
}

/** The testable `accounts inspect` leaf. Every collaborator is an injectable
 *  seam so tests never touch a real observation sidecar, keeper.db, or the
 *  filesystem's runtime-observation tree. */
export async function inspectMain(
  argv: string[],
  deps: AccountsInspectMainDeps = {},
  sink: EnvelopeSink = processEnvelopeSink,
): Promise<void> {
  const args = parseInspectArgs(argv);
  if (args.help) {
    sink.writeStdout(INSPECT_HELP);
    return;
  }
  const env = deps.env ?? process.env;
  const generatedAtMs = Math.floor((deps.now ?? Date.now)());
  const claudeLaunch = (
    deps.inspectClaudeLaunchFn ?? (() => inspectRouting({}))
  )();
  const codexLaunch = (
    deps.inspectCodexLaunchFn ?? productionCodexSessionInspection
  )(env);
  const piRuntime = resolvePiRuntimeBlock(args.reference, deps);
  emitEnvelope(
    successEnvelope(ACCOUNTS_INSPECT_SCHEMA_VERSION, {
      generated_at_ms: generatedAtMs,
      claude_launch: claudeLaunch,
      codex_launch: codexLaunch,
      pi_runtime: piRuntime,
    }),
    sink,
  );
}

// ── group dispatcher ─────────────────────────────────────────────────────────

interface Subverb {
  readonly summary: string;
  readonly run: (rest: string[]) => void | Promise<void>;
}

/** Registration order is the help/listing order. */
const SUBVERBS: Record<string, Subverb> = {
  inspect: {
    summary:
      "Separate Claude launch, Codex launch-seed, and scoped Pi runtime routing (JSON)",
    run: (rest) => inspectMain(rest),
  },
};

const VERB_WIDTH = Math.max(...Object.keys(SUBVERBS).map((v) => v.length));
const VERB_LINES = Object.entries(SUBVERBS)
  .map(([name, spec]) => `  ${name.padEnd(VERB_WIDTH)}  ${spec.summary}`)
  .join("\n");

const HELP = `keeper accounts — read-only Claude/Codex routing + Pi runtime diagnostics

Usage:
  keeper accounts <${Object.keys(SUBVERBS).join("|")}> [<session-reference>] [options]

Verbs:
${VERB_LINES}

Run 'keeper accounts <verb> --help' for a verb's options. Every verb emits JSON
on stdout and never reserves capacity, refreshes an observer, or launches a
subprocess.
`;

export async function main(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const spec = SUBVERBS[verb];
  if (spec === undefined) {
    process.stderr.write(`keeper accounts: unknown verb '${verb}'\n\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }
  await spec.run(argv.slice(1));
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
