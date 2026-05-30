#!/usr/bin/env bun
/**
 * `keeper await <complete|unblocked> <id>` — blocking wait-for-condition
 * subcommand wired on the fn-646 dispatcher.
 *
 * Non-TUI. Emits a Monitor-shaped event stream on stdout:
 *
 *   [keeper-await] armed target=<id> kind=<…> condition=<…> state=<verdict>
 *   [keeper-await] met …    (or `failed reason=… …`)
 *
 * Exactly one `armed` line and exactly one terminal `met` / `failed`
 * line per invocation (the `not-found` first-paint case emits no armed
 * line — the absent-at-arm rejection is the terminal). Diagnostics
 * (verdict-change progress) go to stderr only.
 *
 * Exit codes:
 *   0  met
 *   1  not-found / usage / connection fatal
 *   3  timeout (SIGTERM or our own --timeout deadline)
 *   4  deleted (was on board, vanished, re-query miss)
 *   5  stuck under --fail-on-stuck (default: keep waiting)
 *
 * Authority for both "on board" and "verdict" is `subscribeReadiness`
 * (board-scoped). Tasks live embedded inside epics; the scope-exempt
 * disambiguation re-query is on `epics` filtered by `epic_id` (the pk
 * filter is scope-exempt per `src/collections.ts:253-265`). For a task
 * target we re-query the parent epic and re-check its `tasks[]` array;
 * for an epic target we just check the re-query rows.
 *
 * All flushes go through `process.stdout.write(line, () => process.exit(code))`
 * so a piped fd actually drains before exit. A single `terminating`
 * latch guards every terminal path so SIGTERM racing a met can't double
 * -emit. SIGTERM/SIGINT both route to `failed reason=timeout` exit 3.
 *
 * Reconnect blip is NOT a drop: subscribeReadiness re-gates first-paint
 * on reconnect, and a target absent in the post-reconnect first
 * snapshot is harmless. We only treat a drop as terminal after we've
 * seen the target present in a previous snapshot AND the CURRENT tick
 * is post-reconnect-stable (one full snapshot has landed since the
 * last `connected` lifecycle event).
 */

import { parseArgs } from "node:util";
import {
  type AwaitInputs,
  type AwaitState,
  type AwaitTarget,
  classifyTargetId,
  evaluateAwaitCondition,
} from "../src/await-conditions";
import { resolveSockPath } from "../src/db";
import {
  type ConnectFactory,
  type FatalError,
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic } from "../src/types";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP = `keeper await — block until a planctl board condition holds

Usage:
  keeper await <complete|unblocked> <id> [flags]

Conditions:
  complete     Task: worker_phase=done AND approval=approved.
               Epic:  epic has popped off the board's default-visible
                      scope (approval=approved AND status=closed); a
                      scope-exempt re-query disambiguates that from a
                      hard delete.
  unblocked    Row is workable RIGHT NOW. Concurrency mutexes
               (single-task-per-epic, single-task-per-root) are
               carved OUT — they count as "workable". Every other
               blocker (deps, approval, validation, git, dangling
               -dep, rejection) still blocks.

Flags:
  --timeout <dur>        Own deadline (e.g. 30s, 5m). Default: none.
                         Emits failed reason=timeout exit 3. Use BELOW
                         Monitor's kill timeout if combined.
  --fail-on-stuck        Treat "stuck" verdicts (job-rejected,
                         dep-on-epic-dangling) as terminal exit 5.
                         Default: keep waiting.
  --no-armed-line        Suppress the initial armed line. The terminal
                         line still fires.
  --require-transition   Default off. When set, a condition already
                         true at arm time does NOT fire met; we wait
                         for a real edge.
  --json                 Emit armed / terminal lines as JSON objects
                         instead of [keeper-await] key=value lines.
  --sock <path>          Socket override ($KEEPER_SOCK / default).
  --help                 Show this help.

Exit codes:
  0 met   1 not-found/usage/connect   3 timeout   4 deleted   5 stuck
`;

// ---------------------------------------------------------------------------
// Sanitization for the stdout event channel
// ---------------------------------------------------------------------------

/**
 * Strip CR/LF from a value so an embedded newline can't spoof an
 * adjacent `[keeper-await] …` event. Mirrors the pairctl `emit_event`
 * convention.
 */
function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]/g, " ");
}

// ---------------------------------------------------------------------------
// Event line emit (stdout) and progress line (stderr)
// ---------------------------------------------------------------------------

export interface EmitDeps {
  /** Stdout write (line-only); replaced in tests with a buffer push. */
  writeStdout: (line: string, cb: () => void) => void;
  /** Stderr write (sync) — never carries event semantics. */
  writeStderr: (line: string) => void;
  /** Exit shim; tests inject a thrower. Must not return. */
  exit: (code: number) => never;
  /** JSON mode. */
  json: boolean;
}

function eventLine(
  json: boolean,
  event: string,
  fields: Record<string, string>,
): string {
  if (json) {
    const sanitized: Record<string, string> = { event };
    for (const [k, v] of Object.entries(fields)) {
      sanitized[k] = sanitizeValue(v);
    }
    return `${JSON.stringify(sanitized)}\n`;
  }
  const parts: string[] = [`[keeper-await] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${sanitizeValue(v)}`);
  }
  return `${parts.join(" ")}\n`;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  condition: "complete" | "unblocked";
  id: string;
  kind: "task" | "epic";
  timeoutMs: number | null;
  failOnStuck: boolean;
  noArmedLine: boolean;
  requireTransition: boolean;
  json: boolean;
  sock: string;
}

/**
 * Parse a duration like `30s`, `5m`, `2h`, or a bare-ms integer
 * (`5000` → 5000ms). Returns `null` on parse error. Returns 0 only if
 * the caller literally writes `0` (we accept it; the main loop treats
 * 0 as "no deadline" via the caller-side null check, not here).
 */
export function parseDurationMs(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (m === null) {
    return null;
  }
  const n = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  const unit = m[2] ?? "ms";
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return null;
  }
}

interface ParseFailure {
  ok: false;
  message: string;
}

interface ParseSuccess {
  ok: true;
  args: ParsedArgs;
}

export function parseAwaitArgs(argv: string[]): ParseFailure | ParseSuccess {
  // parseArgs throws on unknown options — we catch and convert to a
  // usage error so the dispatcher / tests can assert on exit 1.
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        timeout: { type: "string" },
        "fail-on-stuck": { type: "boolean" },
        "no-armed-line": { type: "boolean" },
        "require-transition": { type: "boolean" },
        json: { type: "boolean" },
        sock: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (values.help === true) {
    return { ok: false, message: "__help__" };
  }

  if (positionals.length !== 2) {
    return {
      ok: false,
      message: `expected exactly two positional args, got ${positionals.length}`,
    };
  }

  const condRaw = positionals[0] ?? "";
  if (condRaw !== "complete" && condRaw !== "unblocked") {
    return {
      ok: false,
      message: `unknown condition '${condRaw}' (expected 'complete' or 'unblocked')`,
    };
  }
  const condition: "complete" | "unblocked" = condRaw;

  const id = positionals[1] ?? "";
  const kind = classifyTargetId(id);
  if (kind === null) {
    return { ok: false, message: "target id is empty" };
  }

  let timeoutMs: number | null = null;
  const timeoutRaw = values.timeout;
  if (typeof timeoutRaw === "string" && timeoutRaw.length > 0) {
    const parsed = parseDurationMs(timeoutRaw);
    if (parsed === null) {
      return {
        ok: false,
        message: `invalid --timeout '${timeoutRaw}' (expected e.g. 30s, 5m, 2h, or ms integer)`,
      };
    }
    timeoutMs = parsed;
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  return {
    ok: true,
    args: {
      condition,
      id,
      kind,
      timeoutMs,
      failOnStuck: values["fail-on-stuck"] === true,
      noArmedLine: values["no-armed-line"] === true,
      requireTransition: values["require-transition"] === true,
      json: values.json === true,
      sock,
    },
  };
}

// ---------------------------------------------------------------------------
// Runner: dependency-injected so tests can drive without process semantics.
// ---------------------------------------------------------------------------

export interface RunDeps {
  /** Write a stdout line with a flush callback before exit. */
  writeStdout: (line: string, cb: () => void) => void;
  /** Write a stderr line (no flush callback — diagnostics only). */
  writeStderr: (line: string) => void;
  /** Process exit shim; must never return. */
  exit: (code: number) => never;
  /**
   * Register a one-shot SIGTERM/SIGINT handler. Returns an unregister
   * function so the runner can detach on terminate. Tests inject a
   * controllable handler.
   */
  installSignals: (handler: () => void) => () => void;
  /**
   * Optional `connect` factory passed straight through to
   * `subscribeReadiness` / `subscribeCollection`. Production code
   * leaves undefined; tests inject the mock from `test/readiness-client.test.ts`.
   */
  connect?: ConnectFactory;
  /**
   * Timer shim. `null` to skip the deadline timer entirely (tests use
   * this with the manual scheduler). Production: `setTimeout` / `clearTimeout`.
   */
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Result the runner returns to the harness for assertions. Production
 * never observes this — `exit()` runs before the function returns
 * normally. Tests inject a thrower into `exit` and read the result via
 * the caller's captured state.
 */
export interface RunResult {
  /** Was the armed line emitted? */
  armed: boolean;
  /** Terminal line text (post-sanitize), or null if none emitted yet. */
  terminalLine: string | null;
  /** Exit code that was passed to `exit()`. */
  exitCode: number | null;
}

interface RunnerState {
  terminating: boolean;
  armed: boolean;
  /**
   * True once we've seen the target present in a snapshot at least
   * once during the CURRENT connection. Reset on `disconnected`
   * lifecycle so a reconnect blip first-paint absence can't be
   * mistaken for a drop.
   */
  presentThisConnection: boolean;
  /**
   * True once we've ever seen the target present across the whole run.
   * Drives `priorPresence` for the predicate module.
   */
  everSeen: boolean;
  /** Last verdict-phrase emitted to stderr; verdict-change throttle. */
  lastVerdictPhrase: string | null;
  /** True when we're mid-reconnect — first snapshot after is the gate. */
  postReconnectStable: boolean;
  result: RunResult;
}

/**
 * Run the await loop. Returns the result struct AFTER `exit()` has
 * fired (tests resolve via captured state). Production `exit()` calls
 * `process.exit` which never returns, so this fn never returns there.
 */
export async function runAwait(
  args: ParsedArgs,
  deps: RunDeps,
): Promise<RunResult> {
  const target: AwaitTarget = {
    id: args.id,
    kind: args.kind,
    condition: args.condition,
  };

  const state: RunnerState = {
    terminating: false,
    armed: false,
    presentThisConnection: false,
    everSeen: false,
    lastVerdictPhrase: null,
    postReconnectStable: true, // first snapshot is the baseline
    result: { armed: false, terminalLine: null, exitCode: null },
  };

  let handle: ReadinessClientHandle | null = null;
  let deadlineHandle: unknown = null;
  let unregisterSignals: (() => void) | null = null;

  const cleanupSubscriptions = (): void => {
    if (deadlineHandle !== null) {
      deps.clearTimer(deadlineHandle);
      deadlineHandle = null;
    }
    if (handle !== null) {
      try {
        handle.dispose();
      } catch {
        // dispose is idempotent; swallow.
      }
      handle = null;
    }
    if (unregisterSignals !== null) {
      try {
        unregisterSignals();
      } catch {
        // best-effort detach
      }
      unregisterSignals = null;
    }
  };

  /**
   * Terminal write — atomic check-and-set on `terminating` so the
   * SIGTERM ↔ met race can't double-emit. The flush callback runs
   * `exit` so a piped fd actually drains.
   */
  const emitTerminal = (
    event: "met" | "failed",
    code: number,
    fields: Record<string, string>,
  ): void => {
    if (state.terminating) {
      return;
    }
    state.terminating = true;
    cleanupSubscriptions();
    const line = eventLine(args.json, event, fields);
    state.result.terminalLine = line.replace(/\n$/, "");
    state.result.exitCode = code;
    deps.writeStdout(line, () => deps.exit(code));
  };

  const emitArmed = (initial: AwaitState): void => {
    if (args.noArmedLine || state.armed) {
      return;
    }
    state.armed = true;
    state.result.armed = true;
    const line = eventLine(args.json, "armed", {
      target: target.id,
      kind: target.kind,
      condition: target.condition,
      state: initial.detail ?? initial.kind,
    });
    deps.writeStdout(line, () => {
      // Nothing to do post-flush; the loop continues on the next snapshot.
    });
  };

  // Best-effort scope-exempt re-query for the deleted-vs-complete
  // disambiguation. Tasks live embedded in epics, so for both kinds we
  // query the `epics` collection with the pk filter (scope-exempt per
  // collections.ts:253-265). One-shot — we dispose after the first
  // `result` lands. The helper provides its own first-paint gate; the
  // dispose inside `onRows` is safe because the helper's dispose is
  // idempotent.
  const reQueryHit = async (epicIdToFetch: string): Promise<boolean> => {
    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      let oneShotHandle: ReadinessClientHandle | null = null;
      const finish = (hit: boolean): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (oneShotHandle !== null) {
          try {
            oneShotHandle.dispose();
          } catch {
            // idempotent
          }
        }
        resolve(hit);
      };
      try {
        oneShotHandle = subscribeCollection({
          sockPath: args.sock,
          idPrefix: `await-requery-${process.pid}`,
          collection: "epics",
          filter: { epic_id: epicIdToFetch },
          limit: 1,
          onRows: (rows) => {
            // For a task target we still have to check the parent
            // epic's `tasks[]` array — `epic_id` filter returned the
            // epic but the task itself may have been removed even if
            // the epic survives. The caller (in onSnapshot) hands us
            // the appropriate `epicIdToFetch` and inspects the result
            // before deciding met-vs-deleted.
            finish(rows.length > 0 && rows[0] !== undefined);
          },
          onFatal: () => finish(false),
          ...(deps.connect === undefined ? {} : { connect: deps.connect }),
        });
      } catch {
        finish(false);
      }
    });
  };

  /**
   * For task targets the re-query alone isn't enough — the parent epic
   * may survive while the task element was dropped. This helper does
   * the same one-shot re-query and also walks the returned epic's
   * `tasks[]` array.
   */
  const reQueryHitTask = async (taskId: string): Promise<boolean> => {
    const dot = taskId.lastIndexOf(".");
    if (dot <= 0) {
      return false;
    }
    const epicId = taskId.slice(0, dot);
    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      let oneShotHandle: ReadinessClientHandle | null = null;
      const finish = (hit: boolean): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (oneShotHandle !== null) {
          try {
            oneShotHandle.dispose();
          } catch {
            // idempotent
          }
        }
        resolve(hit);
      };
      try {
        oneShotHandle = subscribeCollection({
          sockPath: args.sock,
          idPrefix: `await-requery-task-${process.pid}`,
          collection: "epics",
          filter: { epic_id: epicId },
          limit: 1,
          onRows: (rows) => {
            const row = rows[0];
            if (row === undefined) {
              finish(false);
              return;
            }
            const tasksRaw = (row as { tasks?: unknown }).tasks;
            if (!Array.isArray(tasksRaw)) {
              finish(false);
              return;
            }
            for (const t of tasksRaw) {
              if (
                t !== null &&
                typeof t === "object" &&
                (t as { task_id?: unknown }).task_id === taskId
              ) {
                finish(true);
                return;
              }
            }
            finish(false);
          },
          onFatal: () => finish(false),
          ...(deps.connect === undefined ? {} : { connect: deps.connect }),
        });
      } catch {
        finish(false);
      }
    });
  };

  /**
   * Single snapshot dispatch. Returns nothing; all writes go through
   * `emitTerminal` / `emitArmed` / `writeStderr`. Async because the
   * `deleted` disambiguation runs a one-shot re-query before commit.
   */
  const handleSnapshot = async (
    snap: ReadinessClientSnapshot,
  ): Promise<void> => {
    if (state.terminating) {
      return;
    }

    const inputs: AwaitInputs = {
      epics: snap.epics as readonly Epic[],
      snapshot: snap.readiness,
      priorPresence: state.everSeen,
    };
    let evalState = evaluateAwaitCondition(inputs, target);

    // Track presence both within-connection and across the run BEFORE
    // we make any terminal decision.
    const presentNow =
      evalState.kind !== "not-found" && evalState.kind !== "deleted";
    if (presentNow) {
      state.presentThisConnection = true;
      state.everSeen = true;
    }

    // Reconnect-blip gate: the very first snapshot of a fresh
    // connection counts as a baseline. If the target was previously
    // seen but is absent in this baseline snapshot, swallow the drop
    // — it's a blip — and mark stable so the NEXT snapshot can act.
    // The exception is the first snapshot of the run (no prior
    // connection to be a blip of), which IS terminal on absence.
    const isPostReconnectBaseline = !state.postReconnectStable;
    state.postReconnectStable = true;
    if (isPostReconnectBaseline && state.armed) {
      // Mid-run reconnect baseline. Only blip-swallow if the eval
      // would commit `deleted` — every other state is fine to act on.
      if (evalState.kind === "deleted") {
        const phrase = evalState.detail ?? evalState.kind;
        if (phrase !== state.lastVerdictPhrase) {
          deps.writeStderr(
            `[keeper-await] progress target=${target.id} state=${sanitizeValue(phrase)} (post-reconnect blip)\n`,
          );
          state.lastVerdictPhrase = phrase;
        }
        return;
      }
    }

    // First-paint baseline: emit `armed`, OR `not-found` terminal.
    if (!state.armed && state.result.terminalLine === null) {
      if (evalState.kind === "not-found") {
        emitTerminal("failed", 1, {
          reason: "not-found",
          target: target.id,
          kind: target.kind,
          condition: target.condition,
        });
        return;
      }
      emitArmed(evalState);

      // --require-transition: a condition already true at arm does NOT
      // fire met. We wait for a real edge. Skip the met dispatch on
      // this first tick.
      if (args.requireTransition && evalState.kind === "met") {
        state.lastVerdictPhrase = evalState.detail ?? evalState.kind;
        return;
      }
    }

    // Deleted disambiguation: the absent-branch in await-conditions
    // produces either `deleted` (re-query miss) or `met` (epic-
    // complete + priorPresence + re-query hit). Re-evaluate with the
    // real re-query result before committing.
    if (
      evalState.kind === "deleted" ||
      (target.condition === "complete" &&
        target.kind === "epic" &&
        state.everSeen &&
        !inputs.epics.some((e) => e.epic_id === target.id))
    ) {
      let hit = false;
      try {
        hit =
          target.kind === "task"
            ? await reQueryHitTask(target.id)
            : await reQueryHit(target.id);
      } catch {
        hit = false;
      }
      if (state.terminating) {
        return;
      }
      evalState = evaluateAwaitCondition(
        { ...inputs, reQueryHit: hit },
        target,
      );
    }

    // Verdict-change throttle for stderr progress (never per poll).
    const phrase = evalState.detail ?? evalState.kind;
    if (state.armed && phrase !== state.lastVerdictPhrase) {
      deps.writeStderr(
        `[keeper-await] progress target=${target.id} state=${sanitizeValue(phrase)}\n`,
      );
      state.lastVerdictPhrase = phrase;
    }

    // Terminal dispatch off the AwaitState discriminator.
    switch (evalState.kind) {
      case "met":
        emitTerminal("met", 0, {
          target: target.id,
          kind: target.kind,
          condition: target.condition,
          detail: evalState.detail ?? "",
        });
        return;
      case "deleted":
        emitTerminal("failed", 4, {
          reason: "deleted",
          target: target.id,
          kind: target.kind,
          condition: target.condition,
        });
        return;
      case "stuck":
        if (args.failOnStuck) {
          emitTerminal("failed", 5, {
            reason: "stuck",
            target: target.id,
            kind: target.kind,
            condition: target.condition,
            detail: evalState.detail ?? "",
          });
        }
        // Otherwise: keep waiting. Stderr already logged the change.
        return;
      case "waiting":
      case "not-found":
        // `not-found` after first paint is impossible (priorPresence
        // is sticky once set). Defensive no-op.
        return;
    }
  };

  const onLifecycle = (event: string): void => {
    if (event === "disconnected") {
      state.postReconnectStable = false;
      state.presentThisConnection = false;
    }
  };

  // Custom onFatal — the helper's default `process.exit(1)` would
  // bypass the terminal-line protocol. Route to a proper terminal line.
  const onFatal = (err: FatalError): void => {
    emitTerminal("failed", 1, {
      reason: "connect",
      code: err.code,
      message: err.message,
    });
  };

  // SIGTERM/SIGINT → failed reason=timeout exit 3 through the same
  // `terminating` guard. Monitor sends SIGTERM at its kill timeout.
  unregisterSignals = deps.installSignals(() => {
    emitTerminal("failed", 3, {
      reason: "timeout",
      target: target.id,
      kind: target.kind,
      condition: target.condition,
    });
  });

  // Our own --timeout deadline. If both Monitor's kill timeout AND
  // --timeout are set, the smaller wins — by design, --timeout should
  // be set BELOW Monitor's kill so the protocol-shaped line lands
  // before SIGTERM does.
  if (args.timeoutMs !== null && args.timeoutMs > 0) {
    deadlineHandle = deps.setTimer(() => {
      emitTerminal("failed", 3, {
        reason: "timeout",
        target: target.id,
        kind: target.kind,
        condition: target.condition,
      });
    }, args.timeoutMs);
  }

  handle = subscribeReadiness({
    sockPath: args.sock,
    idPrefix: `await-${process.pid}`,
    onSnapshot: (snap) => {
      void handleSnapshot(snap);
    },
    onLifecycle,
    onFatal,
    ...(deps.connect === undefined ? {} : { connect: deps.connect }),
  });

  return state.result;
}

// ---------------------------------------------------------------------------
// Production main — wires the real process semantics.
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const parsed = parseAwaitArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper await: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(1);
  }

  await runAwait(parsed.args, {
    writeStdout: (line, cb) => process.stdout.write(line, () => cb()),
    writeStderr: (line) => process.stderr.write(line),
    exit: (code) => process.exit(code),
    installSignals: (handler) => {
      const wrap = (): void => handler();
      process.on("SIGTERM", wrap);
      process.on("SIGINT", wrap);
      return () => {
        process.off("SIGTERM", wrap);
        process.off("SIGINT", wrap);
      };
    },
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/await.ts` would
// bypass the dispatcher; if you really need it, run
// `bun cli/keeper.ts await <args>` instead.
