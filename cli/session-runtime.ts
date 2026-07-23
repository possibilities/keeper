#!/usr/bin/env bun

import { statSync } from "node:fs";
import { codexQuotaScopeForModelId } from "../src/codex-quota-scope.ts";
import { resolveSessionId } from "../src/commit-work/session-id.ts";
import { openDb, resolveDbPath } from "../src/db.ts";
import {
  buildSessionRuntimeData,
  type CoalescedRuntimeSample,
  type ExactRuntimeObservation,
  type PiRouteObservation,
  type RuntimeTarget,
  readExactRuntimeObservation,
  readLatestPiRouteObservation,
  resolveSessionRuntimeDir,
  SESSION_RUNTIME_SCHEMA_VERSION,
} from "../src/session-runtime.ts";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope.ts";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference.ts";

export const HELP = `keeper session runtime [<session-reference>]

Emit the latest exact runtime observation for one tracked Session, falling back
to explicitly coalesced jobs telemetry when no exact sample exists. With no
reference, the shared Session resolver uses the ambient Harness identity.

Options:
  --session <ref>       Shared Session reference (alternative to positional)
  --session-id <ref>    Compatibility alias of --session
  --help, -h            Show this help
`;

interface ParsedArgs {
  reference: string | null;
  help: boolean;
}

export interface SessionRuntimeMainDeps extends SessionReferenceCliDeps {
  now?: () => number;
  runtimeDir?: string;
  readExact?: (
    jobId: string,
    runtimeDir: string,
  ) => ExactRuntimeObservation | null;
  readRoute?: (
    target: RuntimeTarget,
    runtimeDir: string,
  ) => PiRouteObservation | null;
  readCoalesced?: (
    jobId: string,
    dbPath: string,
  ) => CoalescedRuntimeSample | null;
}

function usageFault(message: string): never {
  process.stderr.write(`${HELP}\n${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  let reference: string | null = null;
  let help = false;
  const setReference = (value: string | undefined): void => {
    if (value === undefined || value === "")
      usageFault("Expected a Session reference.");
    if (reference !== null)
      usageFault("Specify the Session reference only once.");
    reference = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
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
      usageFault(`Unexpected argument '${arg}'.`);
    }
  }
  return { reference, help };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function readCoalescedRuntimeSample(
  jobId: string,
  dbPath = resolveDbPath(),
): CoalescedRuntimeSample | null {
  try {
    if (!statSync(dbPath).isFile()) return null;
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      const row = db
        .query(
          `SELECT current_model_id, current_model_display, current_effort,
                  context_used_percentage, context_input_tokens,
                  context_window_size
             FROM jobs WHERE job_id = ?`,
        )
        .get(jobId) as Record<string, unknown> | null;
      if (row === null) return null;
      return {
        model_id: nullableText(row.current_model_id),
        model_display: nullableText(row.current_model_display),
        effort: nullableText(row.current_effort),
        used_percentage: nullableNumber(row.context_used_percentage),
        input_tokens: nullableInteger(row.context_input_tokens),
        window_size: nullableInteger(row.context_window_size),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function main(
  argv: string[],
  deps: SessionRuntimeMainDeps = {},
  sink: EnvelopeSink = processEnvelopeSink,
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }

  const reference =
    args.reference ?? resolveSessionId(null, deps.env ?? process.env);
  if (reference === null) {
    emitEnvelope(
      errorEnvelope(
        SESSION_RUNTIME_SCHEMA_VERSION,
        trackedSessionProblem({ kind: "not_found" }),
      ),
      sink,
    );
    return;
  }

  const resolution = resolveTrackedCliSession(reference, deps);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(
        SESSION_RUNTIME_SCHEMA_VERSION,
        trackedSessionProblem(resolution),
      ),
      sink,
    );
    return;
  }

  const target: RuntimeTarget = {
    jobId: resolution.job.jobId,
    harness: resolution.job.harness,
    nativeSessionId: resolution.job.nativeId,
  };
  const runtimeDir = deps.runtimeDir ?? resolveSessionRuntimeDir(deps.env);
  const exact = (deps.readExact ?? readExactRuntimeObservation)(
    target.jobId,
    runtimeDir,
  );
  const coalesced =
    exact === null
      ? (deps.readCoalesced ?? readCoalescedRuntimeSample)(
          target.jobId,
          deps.dbPath ?? resolveDbPath(),
        )
      : null;
  const route =
    exact !== null && target.harness === "pi"
      ? deps.readRoute !== undefined
        ? deps.readRoute(target, runtimeDir)
        : readLatestPiRouteObservation(
            target,
            runtimeDir,
            codexQuotaScopeForModelId(exact.model_id ?? ""),
          )
      : null;
  const data = buildSessionRuntimeData(target, {
    exact,
    coalesced,
    route,
    now: Math.floor((deps.now ?? Date.now)()),
  });
  emitEnvelope(successEnvelope(SESSION_RUNTIME_SCHEMA_VERSION, data), sink);
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
