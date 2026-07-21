#!/usr/bin/env bun
/**
 * `keeper incident <claim|release|rotate> <work::<taskId> | close::<epicId>>
 *  --instance <instance_event_id>` — the session-side writer of the
 * incident-claim spool.
 *
 * A live owning session (a `/plan:work` worker or a `/plan:close` closer) that
 * pulled a merge incident from its claim / close-preflight envelope can record
 * ownership on that incident. This verb writes ONE bounded request leaf into the
 * daemon-watched spool and returns — the daemon incident-claim producer validates
 * claimant liveness and mints the synthetic `IncidentClaimed` / `IncidentReleased`
 * event, the fold records the claim. `rotate` carries the owner's EXPLICIT decline
 * receipt: after the session validates a `declined_clean` return from its resolver
 * subagent, it spools ONE rotate request and the producer — fenced to the incident
 * instance and this live owner — rotates the escalation grant from resolve to
 * deconflict (no event minted; an ordinary `claim` NEVER rotates authority). There
 * is NO socket, NO RPC, and NO session DB write here: this verb never opens
 * keeper.db.
 *
 * The incident is named by its dispatch key (`work::<taskId>` / `close::<epicId>`,
 * the sticky `dispatch_failures` row's `(verb, id)`); `--instance` carries the
 * fencing `instance_event_id` the session read from the incident brief, so a claim
 * can only attach to the exact open incident instance.
 *
 * Exit codes: 0 the request was spooled; 1 persistence failure; 2 usage / arg
 * fault (bad key, missing `--instance`, or no resolvable session identity).
 */

import { parseArgs } from "node:util";
import { resolveSessionId } from "../src/commit-work/session-id";
import {
  buildRequest,
  type IncidentClaimAction,
  isClaimableIncidentIdentity,
  newRequestId,
  parseRequest,
  requestPath,
  writeRequest,
} from "../src/incident-claim-store";
import { parseOptions } from "./descriptor";

/** A terminal envelope was spooled. */
export const EXIT_OK = 0;
/** The validated request could not be persisted. */
export const EXIT_ERROR = 1;
/** Usage / arg fault, or no resolvable claimant identity. */
export const EXIT_USAGE = 2;

export const HELP = `keeper incident — claim, release, or rotate a merge incident from the owning session

Usage:
  keeper incident claim   <work::<taskId> | close::<epicId>> --instance <n> [flags]
  keeper incident release <work::<taskId> | close::<epicId>> --instance <n> [flags]
  keeper incident rotate  <work::<taskId> | close::<epicId>> --instance <n> [flags]

Writes ONE bounded request into the daemon-watched incident-claim spool and
returns. The daemon validates the calling session's liveness and mints the
synthetic claim / release event; the fold records the owner identity and process
generation. \`rotate\` carries the owner's validated \`declined_clean\` receipt: the
daemon rotates the escalation grant from resolve to deconflict, fenced to the
incident instance and this live owner (no event minted). Never opens keeper.db,
never mutates plan state.

Arguments:
  <key>              The incident dispatch key: work::<taskId> or close::<epicId>

Flags:
  --instance <n>     The incident's fencing instance_event_id (from its brief)
  --session-id <id>  Override the calling session's tracked identity
                     (default: resolved from the launch env)
  --help, -h         Show this help

Exit codes:
  0  the request was spooled
  1  the validated request could not be persisted
  2  usage / arg fault, or no resolvable claimant identity
`;

interface Sink {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => never;
}

/** Split a `work::<taskId>` / `close::<epicId>` dispatch key into `(verb, id)`.
 *  Only `work` and `close` are claimable incident verbs; anything else is a
 *  usage fault. */
export function parseIncidentKey(
  key: string,
): { verb: "work" | "close"; id: string } | null {
  const idx = key.indexOf("::");
  if (idx <= 0) return null;
  const verb = key.slice(0, idx);
  const id = key.slice(idx + 2);
  if (
    (verb !== "work" && verb !== "close") ||
    !isClaimableIncidentIdentity(verb, id)
  ) {
    return null;
  }
  return { verb, id };
}

interface ParsedArgs {
  action: IncidentClaimAction;
  key: string;
  instance: string | null;
  sessionId: string | null;
}

type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; help: boolean; message: string | null };

export function parseIncidentArgs(argv: string[]): ParseResult {
  const action = argv[0];
  if (action === "--help" || action === "-h" || action === undefined) {
    return { ok: false, help: true, message: null };
  }
  if (action !== "claim" && action !== "release" && action !== "rotate") {
    return {
      ok: false,
      help: false,
      message: `unknown subcommand '${action}' (expected claim | release | rotate)`,
    };
  }
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      options: parseOptions("incident", action),
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    return {
      ok: false,
      help: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (values.help === true) {
    return { ok: false, help: true, message: null };
  }
  if (positionals.length !== 1) {
    return {
      ok: false,
      help: false,
      message: `expected exactly one incident key (got ${positionals.length})`,
    };
  }
  return {
    ok: true,
    args: {
      action,
      key: positionals[0] as string,
      instance: typeof values.instance === "string" ? values.instance : null,
      sessionId:
        typeof values["session-id"] === "string"
          ? (values["session-id"] as string)
          : null,
    },
  };
}

export interface RunDeps {
  /** Environment for session-id resolution (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** State-dir override forwarded to the spool path (tests). */
  stateDir?: string;
  /** Spool write seam (defaults to a fresh-id atomic write to the spool). */
  write?: (path: string, request: ReturnType<typeof buildRequest>) => void;
  /** Unix-ms clock (defaults to `Date.now`). */
  now?: () => number;
  /** Fresh request-id seam (defaults to a UUID). */
  requestId?: () => string;
}

export interface RunResult {
  exitCode: number;
  /** The spool file written, or null on a usage fault. */
  requestPath: string | null;
}

/**
 * Validate the args, resolve the claimant identity, and spool ONE request. PURE
 * over its deps so a test drives the whole flow with zero real fs / clock.
 */
export function runIncident(
  args: ParsedArgs,
  sink: Sink,
  deps: RunDeps = {},
): RunResult {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const write = deps.write ?? writeRequest;
  const mintId = deps.requestId ?? newRequestId;

  const parsedKey = parseIncidentKey(args.key);
  if (parsedKey == null) {
    sink.writeStderr(
      `keeper incident: not a claimable incident key: '${args.key}' ` +
        "(expected work::<taskId> or close::<epicId>)\n",
    );
    return { exitCode: EXIT_USAGE, requestPath: null };
  }

  if (args.instance == null) {
    sink.writeStderr(
      "keeper incident: --instance <instance_event_id> is required\n",
    );
    return { exitCode: EXIT_USAGE, requestPath: null };
  }
  const instance = Number(args.instance);
  if (!Number.isSafeInteger(instance) || instance <= 0) {
    sink.writeStderr(
      `keeper incident: --instance must be a positive integer, got '${args.instance}'\n`,
    );
    return { exitCode: EXIT_USAGE, requestPath: null };
  }

  const claimant = resolveSessionId(args.sessionId, env);
  if (claimant == null) {
    sink.writeStderr(
      "keeper incident: no resolvable session identity " +
        "(set --session-id or run inside a tracked session)\n",
    );
    return { exitCode: EXIT_USAGE, requestPath: null };
  }

  const request = buildRequest({
    action: args.action,
    verb: parsedKey.verb,
    id: parsedKey.id,
    instanceEventId: instance,
    claimantSessionId: claimant,
    requestedAt: now(),
  });
  // Validate at the CLI boundary even when a test/future caller swaps the real
  // writer seam: no malformed or oversized identity may reach the shared spool.
  if (parseRequest(JSON.stringify(request)) === null) {
    sink.writeStderr(
      "keeper incident: request fields exceed the spool contract\n",
    );
    return { exitCode: EXIT_USAGE, requestPath: null };
  }
  const path = requestPath(mintId(), deps.stateDir);
  try {
    write(path, request);
  } catch (err) {
    sink.writeStderr(
      `keeper incident: failed to write request: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return { exitCode: EXIT_ERROR, requestPath: null };
  }

  sink.writeStdout(
    `${JSON.stringify(
      {
        schema_version: request.schema_version,
        ok: true,
        action: args.action,
        incident_id: args.key,
        verb: parsedKey.verb,
        id: parsedKey.id,
        instance_event_id: instance,
        claimant_session_id: claimant,
        request_path: path,
      },
      null,
      2,
    )}\n`,
  );
  return { exitCode: EXIT_OK, requestPath: path };
}

export function main(argv: string[]): void {
  const sink: Sink = {
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };
  const parsed = parseIncidentArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      sink.writeStdout(HELP);
      return;
    }
    sink.writeStderr(`keeper incident: ${parsed.message}\n\n${HELP}`);
    sink.exit(EXIT_USAGE);
  }
  const result = runIncident(parsed.args, sink);
  if (result.exitCode !== 0) sink.exit(result.exitCode);
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.
if (import.meta.main) {
  main(process.argv.slice(3));
}
