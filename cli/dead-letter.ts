#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import type { DeadLetterOperatorRequest } from "../src/dead-letter";
import type { RpcFrame } from "../src/protocol";
import { sendControlRpc } from "./control-rpc";
import { buildParseOptions, DEAD_LETTER_FLAGS } from "./descriptor";
import { resolveSession } from "./dispatch";

export const DEAD_LETTER_CONTROL_SCHEMA_VERSION = 1;

export const HELP = `keeper dead-letter <reclassify|resolve> <dl-id> [options]

Operate on exactly one poison row. Re-classification re-parses the parked raw
payload with the current parser and preserves the row's original event timestamp.
A still-unclassifiable row remains poison and returns a non-error outcome.
Resolve is a break-glass terminal action: --force and a non-empty --reason are
required, and Keeper records the acting session, reason, force flag, and time.
Repeating resolve returns an idempotent refusal without replacing that audit.

  reclassify <dl-id>             Re-parse one poison row with the current parser
  resolve <dl-id> --force
                  --reason <why> Write an audited non-blocking terminal status
  --sock <path>                  Socket override ($KEEPER_SOCK / default)
  --help                         Show this help
`;

export type ParsedDeadLetterCommand =
  | { kind: "help" }
  | {
      kind: "action";
      sockPath: string;
      request:
        | { op: "reclassify"; dl_id: string }
        | { op: "resolve"; dl_id: string; reason: string; force: true };
    };

export class DeadLetterCliUsageError extends Error {}

export function parseDeadLetterCommand(
  argv: string[],
): ParsedDeadLetterCommand {
  const parsed = parseArgs({
    args: argv,
    options: buildParseOptions(DEAD_LETTER_FLAGS),
    allowPositionals: true,
  });
  if (parsed.values.help === true) return { kind: "help" };
  const [verb, dlId, ...extra] = parsed.positionals;
  if (
    (verb !== "reclassify" && verb !== "resolve") ||
    dlId === undefined ||
    dlId.length === 0 ||
    extra.length > 0
  ) {
    throw new DeadLetterCliUsageError(
      "expected exactly <reclassify|resolve> <dl-id>",
    );
  }
  const sockPath = parsed.values.sock ?? resolveSockPath();
  if (verb === "reclassify") {
    if (parsed.values.force === true || parsed.values.reason !== undefined) {
      throw new DeadLetterCliUsageError(
        "reclassify does not accept --force or --reason",
      );
    }
    return {
      kind: "action",
      sockPath,
      request: { op: "reclassify", dl_id: dlId },
    };
  }
  const reason = parsed.values.reason?.trim();
  if (parsed.values.force !== true || reason === undefined || reason === "") {
    throw new DeadLetterCliUsageError(
      "resolve requires both --force and a non-empty --reason",
    );
  }
  return {
    kind: "action",
    sockPath,
    request: { op: "resolve", dl_id: dlId, reason, force: true },
  };
}

export function buildDeadLetterRpcFrame(
  id: string,
  request: ParsedDeadLetterCommand & { kind: "action" },
  callerSession: string,
): RpcFrame {
  let params: DeadLetterOperatorRequest;
  if (request.request.op === "reclassify") {
    params = request.request;
  } else {
    params = {
      ...request.request,
      caller_session: callerSession,
    };
  }
  return {
    type: "rpc",
    id,
    method: "resolve_dead_letter",
    params,
  };
}

export async function main(argv: string[]): Promise<void> {
  let parsed: ParsedDeadLetterCommand;
  try {
    parsed = parseDeadLetterCommand(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`keeper dead-letter: ${message}\n\n${HELP}`);
    process.exit(2);
  }
  if (parsed.kind === "help") {
    process.stdout.write(HELP);
    return;
  }
  const { session } = resolveSession({ sessionFlag: undefined });
  const id = crypto.randomUUID();
  await sendControlRpc(
    parsed.sockPath,
    buildDeadLetterRpcFrame(id, parsed, session),
    id,
    DEAD_LETTER_CONTROL_SCHEMA_VERSION,
  );
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
