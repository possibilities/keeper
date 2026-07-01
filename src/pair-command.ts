/**
 * Pure, dep-free plumbing specific to `keeper pair` — the pairing helper that
 * fans a task out to another model CLI (claude / codex / pi) via `keeper agent`
 * as the launch transport. Owns the pair-ONLY ergonomics: prompt assembly, the
 * `--timeout`→ms budget, the output-YAML result contract, and the default
 * session name. The SHARED launch cluster (per-CLI argv builder, native flag
 * sets, env strip, read-only directive, role resolver) lives in the neutral
 * `src/agent/launch-config.ts` module.
 *
 * LEAF-MODULE DISCIPLINE (mirrors `src/dispatch-command.ts`): this module imports
 * `js-yaml` (a serialization dep, not the DB graph) and the dep-free
 * `src/agent/launch-config.ts` leaf; it MUST NOT pull `bun:sqlite` or `./db`. The
 * orchestration lives in the thin `cli/pair.ts` entry.
 */

import yaml from "js-yaml";
import { type AgentCli, READ_ONLY_DIRECTIVE } from "./agent/launch-config";

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Build the full prompt the partner receives: prepend the read-only directive
 * (when set), then the role's system prompt, then the user message. Each block
 * is separated by a blank line. `keeper pair` is single-turn (no resume), so
 * this is always the turn-1 shape. Pure — exported for tests.
 */
export function assemblePrompt(args: {
  message: string;
  systemPrompt: string;
  readOnly: boolean;
}): string {
  const parts: string[] = [];
  if (args.readOnly) {
    parts.push(READ_ONLY_DIRECTIVE);
  }
  if (args.systemPrompt !== "") {
    parts.push(`System: ${args.systemPrompt}`);
  }
  parts.push(`User: ${args.message}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Stop-wait budget
// ---------------------------------------------------------------------------

/** keeper's `--timeout` (seconds) → the stop-wait budget in ms, threaded onto the
 *  pinned handle's `stopTimeoutMs` so the in-process wait honors it instead of the
 *  launcher's 600s default. A fractional `--timeout` rounds UP to ms granularity
 *  so the partner is never short-changed. Pure — exported for tests. */
export function stopTimeoutMsFromSeconds(timeoutSeconds: number): number {
  return Math.ceil(timeoutSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Output-YAML assembly — the `--output` result contract
// ---------------------------------------------------------------------------

/** Inputs to {@link buildPairOutput}. */
export interface PairOutputOpts {
  /** Partner CLI. */
  cli: AgentCli;
  /** Role used. */
  role: string;
  /** The partner's final assistant message (null for a tool-only/refusal turn). */
  message: string | null;
  /** keeper agent transcript path drill-down pointer. */
  transcriptPath: string | null;
  /** keeper agent run id handle (the session drill-down key). */
  handle: string;
  /** Elapsed wall seconds. */
  elapsedSeconds?: number;
}

/**
 * Assemble the `--output` payload: a top `message` (the partner's final
 * answer), the cli/role echo, and the transcript + session drill-down keys.
 * Returns the structured object; the caller serializes it to YAML. Pure —
 * exported for tests.
 */
export function buildPairOutput(opts: PairOutputOpts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    cli: opts.cli,
    role: opts.role,
    message: opts.message ?? "",
  };
  if (opts.elapsedSeconds !== undefined) {
    out.elapsed_seconds = Math.round(opts.elapsedSeconds * 10) / 10;
  }
  out.handle = opts.handle;
  if (opts.transcriptPath !== null) {
    out.transcript_path = opts.transcriptPath;
  }
  return out;
}

/** Serialize a pair-output object to YAML text. Centralized so the CLI and
 *  tests share one serializer. */
export function pairOutputYaml(output: Record<string, unknown>): string {
  return yaml.dump(output, { lineWidth: -1 });
}

// ---------------------------------------------------------------------------
// tmux session naming
// ---------------------------------------------------------------------------

/** Default tmux session for `keeper pair` partners when `--session` is absent.
 *  A stable named session (not a per-launch unique name) so partners are easy to
 *  find/attach; keeper agent's race-safe launch lets concurrent partners share it. */
export const DEFAULT_PAIR_SESSION = "pair";
