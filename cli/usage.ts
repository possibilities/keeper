#!/usr/bin/env bun
/** `keeper usage` — live Claude and Codex Capacity observations. */

import { parseArgs } from "node:util";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import {
  buildUsageJsonData,
  createUsagePoller,
  loadUsageSnapshot,
  renderUsageLines,
  resolveUsageSnapshotPaths,
  type UsageSnapshot,
  type UsageSnapshotPaths,
} from "../src/usage-observation-view";
import { createViewShell } from "../src/view-shell";
import { buildParseOptions, USAGE_FLAGS } from "./descriptor";
import { parseDuration } from "./duration";
import {
  type EnvelopeSink,
  emitEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope";

export const HELP = `keeper usage — live Claude and Codex account capacity

Usage: keeper usage [--snapshot | --watch] [--timeout <duration>]
       keeper usage --json

  --snapshot      Force one current frame + exit, even on a TTY
  --watch         Force the live TUI when stdout is piped
  --timeout <dur> Snapshot wait bound (unit required, e.g. 500ms, 2s)
  --json          Emit the schema-v1 one-shot JSON envelope and exit
                  (rejects --watch; ignores --snapshot/--timeout)
  --help, -h      Show this help

The viewer reads Keeper's private, PII-free Capacity observation sidecars and
appends Fable and Non-Fable Account-focus state after the provider usage blocks.
Claude meters use cswap's dynamic window keys; Codex meters retain bounded
provider names such as GPT-5.3-Codex-Spark and derive unnamed base windows from
their duration. Added meters appear and removed meters disappear on the next
poll. Missing, invalid, stale, exhausted, and unavailable observations remain
visible instead of being treated as unused capacity.

TTY mode polls once per second. Non-TTY stdout defaults to one snapshot followed
by a machine-parseable keeper-meta: line. --json instead emits ONE
{schema_version, ok, error, data} envelope on stdout — no human frame, no
keeper-meta: line — preserving every normalized meter, category/multiplier,
source status, and the display-only last-good measurement. A missing, stale, or
unavailable source is reported as explicit partial data, never a command
failure. KEEPER_ACCOUNT_ROUTING_ROOT and KEEPER_CODEX_ACCOUNT_ROUTING_ROOT
override the two sidecar roots.
`;

export const USAGE_JSON_SCHEMA_VERSION = 1;

export interface RunUsageJsonConfig {
  paths?: UsageSnapshotPaths;
  nowMs?: () => number;
  sink?: EnvelopeSink;
}

/** The testable one-shot JSON leaf: loads the current sidecar snapshot and
 *  emits the schema-v1 envelope. No daemon socket, no polling, no side effect. */
export function runUsageJson(config: RunUsageJsonConfig = {}): void {
  const paths = config.paths ?? resolveUsageSnapshotPaths();
  const nowMs = config.nowMs ?? Date.now;
  const snapshot = loadUsageSnapshot(paths, nowMs());
  emitEnvelope(
    successEnvelope(USAGE_JSON_SCHEMA_VERSION, buildUsageJsonData(snapshot)),
    config.sink ?? processEnvelopeSink,
  );
}

export interface RunUsageConfig {
  mode: "live" | "snapshot";
  paths?: UsageSnapshotPaths;
  timeoutMs?: number;
  nowMs?: () => number;
  pollIntervalMs?: number;
}

export async function runUsage(config: RunUsageConfig): Promise<void> {
  const paths = config.paths ?? resolveUsageSnapshotPaths();
  const nowMs = config.nowMs ?? Date.now;
  const view = createViewShell<UsageSnapshot>({
    script: "usage",
    title: "usage",
    mode: config.mode,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    renderBody: (snapshot) => ({
      bodyLines: renderUsageLines(snapshot),
      stateJson: snapshot,
    }),
  });

  if (config.mode === "snapshot") {
    view.emit(loadUsageSnapshot(paths, nowMs()));
    view.runSnapshot(() => undefined);
    return;
  }

  const poller = createUsagePoller({
    read: () => loadUsageSnapshot(paths, nowMs()),
    onSemanticChange: (snapshot) => void view.emit(snapshot),
    onLocalRepaint: (snapshot) => void view.repaintLocal(snapshot),
    ...(config.pollIntervalMs === undefined
      ? {}
      : { intervalMs: config.pollIntervalMs }),
  });
  poller.start();
  view.installSigintHandler(() => poller.dispose());
}

function parseUsageArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: buildParseOptions(USAGE_FLAGS),
    allowPositionals: false,
    strict: true,
  });
}

export async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseUsageArgs>;
  try {
    parsed = parseUsageArgs(argv);
  } catch (error) {
    process.stderr.write(
      `keeper usage: ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`,
    );
    process.exit(2);
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (values.json) {
    if (values.watch) {
      process.stderr.write(
        `keeper usage: --json and --watch are mutually exclusive\n\n${HELP}`,
      );
      process.exit(2);
    }
    runUsageJson();
    return;
  }

  let mode: "snapshot" | "watch";
  try {
    mode = resolveSnapshotMode({
      snapshotFlag: values.snapshot ?? false,
      watchFlag: values.watch ?? false,
      stdoutIsTTY: process.stdout.isTTY,
      env: process.env,
    });
  } catch (error) {
    if (error instanceof SnapshotCliMisuseError) {
      process.stderr.write(`keeper usage: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const duration = parseDuration(values.timeout);
    if (!duration.ok) {
      process.stderr.write(`keeper usage: --timeout ${duration.message}\n`);
      process.exit(2);
    }
    timeoutMs = duration.ms;
  }

  await runUsage({
    mode: mode === "snapshot" ? "snapshot" : "live",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

// `cli/keeper.ts` is the canonical entry and owns argument pruning.
