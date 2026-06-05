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
  agentsIdleState,
  classifyTargetId,
  evaluateAwaitCondition,
  gitCleanState,
  type PlanctlCondition,
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
import type { Epic, GitStatus, Job } from "../src/types";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP = `keeper await — block until a planctl/git/job condition holds

Usage:
  keeper await <condition> [<id>] [and <condition> [<id>]]... [flags]

Conditions:
  complete <id>   Task: worker_phase=done AND approval=approved.
                  Epic:  epic has popped off the board's default-visible
                         scope (approval=approved AND status=closed); a
                         scope-exempt re-query disambiguates that from a
                         hard delete.
  unblocked <id>  Row is workable RIGHT NOW. Concurrency mutexes
                  (single-task-per-epic, single-task-per-root) are
                  carved OUT — they count as "workable". Every other
                  blocker (deps, approval, validation, git, dangling
                  -dep, rejection) still blocks.
  git-clean       The cwd's git root has dirty_count=0 AND orphaned_count=0
                  (no git_status row for the root counts as clean). Takes
                  no id.
  agents-idle     No OTHER session (job_id != CLAUDE_CODE_SESSION_ID) with
                  state=working has a cwd inside the cwd's git root. Takes
                  no id.

Multiple conditions joined by the literal 'and' token block until ALL hold
simultaneously (level-triggered, glitch-free). A planctl sub-condition going
not-found / deleted / stuck short-circuits the whole wait with that reason.

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

/**
 * One parsed condition segment. The two planctl families carry an
 * {@link AwaitTarget} (id + kind + condition); `git-clean` / `agents-idle`
 * carry only the condition tag.
 */
export type ConditionSegment =
  | { condition: PlanctlCondition; target: AwaitTarget }
  | { condition: "git-clean" }
  | { condition: "agents-idle" };

export interface ParsedArgs {
  /** One or more condition segments, ANDed. Always >= 1. */
  segments: ConditionSegment[];
  timeoutMs: number | null;
  failOnStuck: boolean;
  noArmedLine: boolean;
  requireTransition: boolean;
  json: boolean;
  sock: string;
}

/** Conditions that take exactly one planctl id positional. */
const PLANCTL_CONDITIONS: ReadonlySet<string> = new Set([
  "complete",
  "unblocked",
]);
/** Conditions that take NO positional arg. */
const NULLARY_CONDITIONS: ReadonlySet<string> = new Set([
  "git-clean",
  "agents-idle",
]);

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

  // Split the positionals on the literal `and` token into per-condition
  // segments. `[c1, id1, "and", c2, "and", c3, id3]` →
  // `[[c1, id1], [c2], [c3, id3]]`. An `and` at the head/tail or two in a
  // row yields an empty segment, rejected below.
  if (positionals.length === 0) {
    return { ok: false, message: "expected at least one condition" };
  }
  const rawSegments: string[][] = [];
  let cur: string[] = [];
  for (const tok of positionals) {
    if (tok === "and") {
      rawSegments.push(cur);
      cur = [];
      continue;
    }
    cur.push(tok);
  }
  rawSegments.push(cur);

  const segments: ConditionSegment[] = [];
  const seen = new Set<string>();
  for (const seg of rawSegments) {
    if (seg.length === 0) {
      return {
        ok: false,
        message: "empty condition segment (stray or duplicate 'and' token)",
      };
    }
    const condRaw = seg[0] ?? "";
    const rest = seg.slice(1);
    if (PLANCTL_CONDITIONS.has(condRaw)) {
      if (rest.length !== 1) {
        return {
          ok: false,
          message: `condition '${condRaw}' takes exactly one id (got ${rest.length})`,
        };
      }
      const id = rest[0] ?? "";
      const kind = classifyTargetId(id);
      if (kind === null) {
        return { ok: false, message: "target id is empty" };
      }
      const condition = condRaw as PlanctlCondition;
      const dupKey = `${condition}:${id}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({
        condition,
        target: { id, kind, condition },
      });
    } else if (NULLARY_CONDITIONS.has(condRaw)) {
      if (rest.length !== 0) {
        return {
          ok: false,
          message: `condition '${condRaw}' takes no id (got ${rest.length} extra arg(s))`,
        };
      }
      if (seen.has(condRaw)) {
        return { ok: false, message: `duplicate condition '${condRaw}'` };
      }
      seen.add(condRaw);
      segments.push({ condition: condRaw as "git-clean" | "agents-idle" });
    } else {
      return {
        ok: false,
        message: `unknown condition '${condRaw}' (expected complete, unblocked, git-clean, agents-idle)`,
      };
    }
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
      segments,
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
  /**
   * The cwd's resolved git toplevel (fn-713). Side-effect read done in
   * `main` via a one-shot `git rev-parse --show-toplevel`; `null` when the
   * cwd isn't inside a git worktree (the runner emits
   * `failed reason=no-git-root` exit 1 at arm time when any condition needs
   * a root). Only consulted by `git-clean` / `agents-idle` segments — a
   * pure planctl invocation tolerates `null`.
   */
  gitRoot: string | null;
  /**
   * The caller's own `CLAUDE_CODE_SESSION_ID` (fn-713), read once at
   * startup for `agents-idle` self-exclusion. `null` when unset (the
   * self-exclusion becomes a no-op).
   */
  ownSessionId: string | null;
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

/**
 * Per-planctl-slot mutable state. Each `complete`/`unblocked` segment
 * keeps its own presence / re-query / reconnect machinery so the
 * single-segment path stays byte-identical and a multi-segment AND
 * tracks each planctl target independently.
 */
interface PlanctlSlotState {
  readonly kind: "planctl";
  readonly target: AwaitTarget;
  /** Latched: has this slot's condition been met? Booted to false. */
  met: boolean;
  /** Last AwaitState this slot evaluated to (for the line render). */
  lastEval: AwaitState | null;
  /** Seen present in the CURRENT connection (reconnect-blip gate). */
  presentThisConnection: boolean;
  /** Seen present at least once across the run (drives priorPresence). */
  everSeen: boolean;
  /** Verdict-change throttle for stderr progress. */
  lastVerdictPhrase: string | null;
}

/**
 * Per-git/jobs-slot mutable state. Simpler than the planctl slot — these
 * families have no `deleted`/`stuck` semantic; an absent row is MET, so
 * the slot only latches `met` plus a per-slot verdict-change throttle.
 */
interface GitJobSlotState {
  readonly kind: "git-clean" | "agents-idle";
  met: boolean;
  lastEval: AwaitState | null;
  lastVerdictPhrase: string | null;
}

type SlotState = PlanctlSlotState | GitJobSlotState;

interface RunnerState {
  terminating: boolean;
  armed: boolean;
  result: RunResult;
}

/**
 * Run the await loop. Returns the result struct AFTER `exit()` has
 * fired (tests resolve via captured state). Production `exit()` calls
 * `process.exit` which never returns, so this fn never returns there.
 *
 * Generalized to N latched condition slots (fn-713): one slot per
 * `args.segments` entry. The aggregate emits a single terminal `met` only
 * when EVERY slot is simultaneously met; any planctl sub-condition going
 * `not-found`/`deleted`/`stuck`(under `--fail-on-stuck`) short-circuits the
 * whole process. A single planctl segment reproduces the pre-fn-713 line
 * shape + exit codes byte-for-byte.
 */
export async function runAwait(
  args: ParsedArgs,
  deps: RunDeps,
): Promise<RunResult> {
  const single = args.segments.length === 1;

  // Which subscription streams do we need? planctl → subscribeReadiness
  // (it also exposes raw git/jobs rows, so a planctl-bearing combo reads
  // git/jobs off the one snapshot and skips the extra subscribe). git/jobs
  // WITHOUT any planctl segment → dedicated subscribeCollection streams.
  const hasPlanctl = args.segments.some(
    (s) => s.condition === "complete" || s.condition === "unblocked",
  );
  const hasGitClean = args.segments.some((s) => s.condition === "git-clean");
  const hasAgentsIdle = args.segments.some(
    (s) => s.condition === "agents-idle",
  );
  const needsRoot = hasGitClean || hasAgentsIdle;
  // Open the readiness stream when any planctl segment is present; it
  // already folds git + jobs so those families ride it. Otherwise open a
  // dedicated git / jobs collection stream per family used.
  const openReadiness = hasPlanctl;
  const openGitCollection = hasGitClean && !hasPlanctl;
  const openJobsCollection = hasAgentsIdle && !hasPlanctl;

  // Build the latched slots in segment order (the line render walks them).
  const slots: SlotState[] = args.segments.map((seg): SlotState => {
    if (seg.condition === "complete" || seg.condition === "unblocked") {
      return {
        kind: "planctl",
        target: seg.target,
        met: false,
        lastEval: null,
        presentThisConnection: false,
        everSeen: false,
        lastVerdictPhrase: null,
      };
    }
    return {
      kind: seg.condition,
      met: false,
      lastEval: null,
      lastVerdictPhrase: null,
    };
  });

  // Latest git/jobs rows, populated either off the readiness snapshot or
  // the dedicated collection streams. Null until first-painted.
  let latestGitRows: readonly GitStatus[] | null = null;
  let latestJobRows: readonly Job[] | null = null;
  // Latest readiness snapshot (null until first paint); planctl + (when
  // riding readiness) git/jobs read off it.
  let latestReadiness: ReadinessClientSnapshot | null = null;

  // Aggregate first-paint gate: hold `armed` + the first eval until EVERY
  // opened subscription has first-painted. `painted` flags flip on the
  // first `result` per stream; reset on that stream's `disconnected`.
  const paintGate = {
    readiness: !openReadiness,
    git: !openGitCollection,
    jobs: !openJobsCollection,
  };
  const allPainted = (): boolean =>
    paintGate.readiness && paintGate.git && paintGate.jobs;

  const state: RunnerState = {
    terminating: false,
    armed: false,
    result: { armed: false, terminalLine: null, exitCode: null },
  };

  // Per-stream post-reconnect-stable flags: the first snapshot of a fresh
  // connection is the baseline (`true`), reset to `false` on that stream's
  // `disconnected` so a reconnect-blip first paint can't be acted on as a
  // drop. One flag per opened stream; generalizes the pre-fn-713 single
  // `postReconnectStable`.
  const reconnectStable = {
    readiness: true,
    git: true,
    jobs: true,
  };

  let readinessHandle: ReadinessClientHandle | null = null;
  let gitHandle: ReadinessClientHandle | null = null;
  let jobsHandle: ReadinessClientHandle | null = null;
  let deadlineHandle: unknown = null;
  let unregisterSignals: (() => void) | null = null;

  const cleanupSubscriptions = (): void => {
    if (deadlineHandle !== null) {
      deps.clearTimer(deadlineHandle);
      deadlineHandle = null;
    }
    for (const h of [readinessHandle, gitHandle, jobsHandle]) {
      if (h !== null) {
        try {
          h.dispose();
        } catch {
          // dispose is idempotent; swallow.
        }
      }
    }
    readinessHandle = null;
    gitHandle = null;
    jobsHandle = null;
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

  // Best-effort prose of a slot's condition for the line render. For a
  // planctl slot it's `<condition> <id>`; for git/jobs it's the bare
  // condition tag.
  const slotLabel = (slot: SlotState): string =>
    slot.kind === "planctl"
      ? `${slot.target.condition} ${slot.target.id}`
      : slot.kind;

  const emitArmed = (initials: AwaitState[]): void => {
    if (args.noArmedLine || state.armed) {
      return;
    }
    state.armed = true;
    state.result.armed = true;
    let fields: Record<string, string>;
    if (single && slots[0]?.kind === "planctl") {
      // Byte-identical single-planctl line shape (external contract).
      const t = slots[0].target;
      const initial = initials[0] ?? { kind: "waiting" as const };
      fields = {
        target: t.id,
        kind: t.kind,
        condition: t.condition,
        state: initial.detail ?? initial.kind,
      };
    } else if (single) {
      // Single git/jobs condition: bare condition + state.
      const initial = initials[0] ?? { kind: "waiting" as const };
      fields = {
        condition: slots[0]?.kind ?? "",
        state: initial.detail ?? initial.kind,
      };
    } else {
      // Aggregate: summarize each ANDed condition.
      fields = {
        conditions: slots.map(slotLabel).join(" and "),
        count: String(slots.length),
      };
    }
    const line = eventLine(args.json, "armed", fields);
    deps.writeStdout(line, () => {
      // Nothing to do post-flush; the loop continues on the next snapshot.
    });
  };

  // Emit the aggregate terminal `met` (single line; for a single planctl
  // slot the field shape is byte-identical to pre-fn-713).
  const emitAggregateMet = (): void => {
    if (single && slots[0]?.kind === "planctl") {
      const t = slots[0].target;
      emitTerminal("met", 0, {
        target: t.id,
        kind: t.kind,
        condition: t.condition,
        detail: slots[0].lastEval?.detail ?? "",
      });
      return;
    }
    if (single) {
      emitTerminal("met", 0, {
        condition: slots[0]?.kind ?? "",
        detail: slots[0]?.lastEval?.detail ?? "",
      });
      return;
    }
    emitTerminal("met", 0, {
      conditions: slots.map(slotLabel).join(" and "),
      count: String(slots.length),
    });
  };

  // A planctl slot reached a short-circuit terminal failure (not-found /
  // deleted / stuck). For a single segment the line is byte-identical;
  // for an aggregate it names which condition failed.
  const emitPlanctlFailure = (
    slot: PlanctlSlotState,
    reason: "not-found" | "deleted" | "stuck",
    code: number,
    detail: string | undefined,
  ): void => {
    const t = slot.target;
    const base: Record<string, string> = {
      reason,
      target: t.id,
      kind: t.kind,
      condition: t.condition,
    };
    if (detail !== undefined && detail.length > 0) {
      base.detail = detail;
    }
    if (!single) {
      base.from = slotLabel(slot);
    }
    emitTerminal("failed", code, base);
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

  // ---- per-slot evaluation -------------------------------------------

  /**
   * SYNCHRONOUS first pass over one planctl slot off the latest readiness
   * snapshot. Computes the `AwaitState` WITHOUT the `deleted` re-query —
   * critically synchronous so `armed` can fire on the same turn as the
   * frame delivery (the pre-fn-713 contract; an `await` here would defer
   * arming to a microtask and break the line protocol).
   *
   * Returns `{ result, blip, needsReQuery }`:
   *   - `blip`        — a post-reconnect baseline absence that must be
   *                     swallowed (don't commit this tick).
   *   - `needsReQuery`— the slot's absent/complete-drop path needs the
   *                     scope-exempt re-query to disambiguate
   *                     `deleted`-vs-`met` before commit; the async wrapper
   *                     runs that and re-evaluates.
   */
  const evalPlanctlSlotSync = (
    slot: PlanctlSlotState,
    snap: ReadinessClientSnapshot,
    isReconnectBaseline: boolean,
  ): { result: AwaitState; blip: boolean; needsReQuery: boolean } => {
    const inputs: AwaitInputs = {
      epics: snap.epics as readonly Epic[],
      snapshot: snap.readiness,
      priorPresence: slot.everSeen,
    };
    const evalState = evaluateAwaitCondition(inputs, slot.target);

    const presentNow =
      evalState.kind !== "not-found" && evalState.kind !== "deleted";
    if (presentNow) {
      slot.presentThisConnection = true;
      slot.everSeen = true;
    }

    // Reconnect-blip gate: a post-reconnect baseline absence that would
    // commit `deleted` is swallowed (only AFTER we've armed).
    if (isReconnectBaseline && state.armed && evalState.kind === "deleted") {
      return { result: evalState, blip: true, needsReQuery: false };
    }

    const needsReQuery =
      evalState.kind === "deleted" ||
      (slot.target.condition === "complete" &&
        slot.target.kind === "epic" &&
        slot.everSeen &&
        !inputs.epics.some((e) => e.epic_id === slot.target.id));
    return { result: evalState, blip: false, needsReQuery };
  };

  /**
   * Kick off the scope-exempt re-query promise for one slot WITHOUT an
   * extra async wrapper — `evaluate` awaits this directly so the microtask
   * resume chain stays as shallow as the pre-fn-713 single-target path
   * (the runner test harness flushes a fixed number of microtasks between
   * delivering the re-query result and asserting). Returns the raw hit
   * promise; the caller folds it into `evaluateAwaitCondition`.
   */
  const reQueryForSlot = (slot: PlanctlSlotState): Promise<boolean> =>
    slot.target.kind === "task"
      ? reQueryHitTask(slot.target.id)
      : reQueryHit(slot.target.id);

  // Per-slot stderr progress throttle (verdict-change only, never per
  // poll). `slot.lastVerdictPhrase` carries the throttle key.
  const logProgress = (
    slot: SlotState,
    evalState: AwaitState,
    suffix = "",
  ): void => {
    if (!state.armed) {
      return;
    }
    const phrase = evalState.detail ?? evalState.kind;
    if (phrase !== slot.lastVerdictPhrase) {
      const label = slot.kind === "planctl" ? slot.target.id : slot.kind;
      deps.writeStderr(
        `[keeper-await] progress target=${label} state=${sanitizeValue(phrase)}${suffix}\n`,
      );
      slot.lastVerdictPhrase = phrase;
    }
  };

  /**
   * Shared re-evaluation pass — the ONE place the AND gate is computed.
   * Walks every slot, evaluates each off the latest rows it cares about,
   * latches `met`, short-circuits on any planctl terminal failure, and
   * emits the aggregate `met` only when EVERY slot is simultaneously met.
   *
   * Held behind the aggregate first-paint gate (`allPainted()`): until
   * every opened subscription has first-painted we neither arm nor eval,
   * so a slow stream can't let the AND glitch-fire early.
   */
  const evaluate = async (): Promise<void> => {
    if (state.terminating) {
      return;
    }
    if (!allPainted()) {
      return;
    }

    // Capture which streams just first-painted for the reconnect-blip
    // gate, then mark all stable. (Stream-scoped; the readiness slots key
    // off the readiness flag, git/jobs slots off their own.)
    const readinessBaseline = !reconnectStable.readiness;
    reconnectStable.readiness = true;
    reconnectStable.git = true;
    reconnectStable.jobs = true;

    // --- Pass 1: SYNCHRONOUS slot evaluation (no re-query). Everything
    // here runs on the same turn as the frame delivery so `armed` /
    // synchronous terminals fire before any `await`. Slots that need the
    // scope-exempt re-query are collected for the deferred pass 2.
    const evals: (AwaitState | null)[] = slots.map(() => null);
    const deferred: number[] = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined) {
        continue;
      }
      if (slot.kind === "planctl") {
        if (latestReadiness === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const { result, blip, needsReQuery } = evalPlanctlSlotSync(
          slot,
          latestReadiness,
          readinessBaseline,
        );
        slot.lastEval = result;
        if (blip) {
          logProgress(slot, result, " (post-reconnect blip)");
          evals[i] = slot.met ? { kind: "met" } : { kind: "waiting" };
          continue;
        }
        if (needsReQuery) {
          // Hold this slot's commit for pass 2; treat as not-yet-met for
          // the synchronous arming snapshot.
          deferred.push(i);
          evals[i] = slot.met ? { kind: "met" } : { kind: "waiting" };
          continue;
        }
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "git-clean") {
        if (latestGitRows === null || deps.gitRoot === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = gitCleanState(deps.gitRoot, latestGitRows);
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      } else {
        // agents-idle
        if (latestJobRows === null || deps.gitRoot === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = agentsIdleState(
          deps.gitRoot,
          deps.ownSessionId,
          latestJobRows,
        );
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      }
    }

    // First-paint baseline: arm OR emit a planctl `not-found` terminal.
    // A `not-found` only arises on the synchronous (non-deferred) path —
    // the deferred path is a present-then-absent drop, which is
    // `deleted`/`met`, never `not-found`.
    let justArmed = false;
    if (!state.armed && state.result.terminalLine === null) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const ev = evals[i];
        if (slot?.kind === "planctl" && ev?.kind === "not-found") {
          emitPlanctlFailure(slot, "not-found", 1, undefined);
          return;
        }
      }
      emitArmed(evals.map((e) => e ?? { kind: "waiting" }));
      justArmed = state.armed;
    }

    // --require-transition: a slot already met on the very tick we armed
    // does NOT fire met. We wait for a real edge — skip the terminal
    // dispatch on the arming tick (a later snapshot re-runs `evaluate`).
    if (justArmed && args.requireTransition) {
      return;
    }

    // --- Pass 2: ASYNC re-query for the deferred slots. Await each hit
    // directly (one await hop, matching the pre-fn-713 depth), fold the
    // result back in, then fall through to the shared terminal check.
    if (deferred.length > 0 && latestReadiness !== null) {
      const snap = latestReadiness;
      for (const i of deferred) {
        const slot = slots[i];
        if (slot === undefined || slot.kind !== "planctl") {
          continue;
        }
        let hit = false;
        try {
          hit = await reQueryForSlot(slot);
        } catch {
          hit = false;
        }
        if (state.terminating) {
          return;
        }
        const result = evaluateAwaitCondition(
          {
            epics: snap.epics as readonly Epic[],
            snapshot: snap.readiness,
            priorPresence: slot.everSeen,
            reQueryHit: hit,
          },
          slot.target,
        );
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      }
    }

    // Short-circuit on any planctl terminal failure (deleted / stuck).
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (slot?.kind !== "planctl" || ev === undefined || ev === null) {
        continue;
      }
      if (ev.kind === "deleted") {
        emitPlanctlFailure(slot, "deleted", 4, undefined);
        return;
      }
      if (ev.kind === "stuck" && args.failOnStuck) {
        emitPlanctlFailure(slot, "stuck", 5, ev.detail);
        return;
      }
    }

    // Aggregate met: every slot latched met.
    if (slots.every((s) => s.met)) {
      emitAggregateMet();
    }
  };

  // ---- stream callbacks ----------------------------------------------

  const onReadinessSnapshot = (snap: ReadinessClientSnapshot): void => {
    latestReadiness = snap;
    paintGate.readiness = true;
    // When riding readiness for git/jobs (a planctl-bearing combo), pull
    // the raw rows off the snapshot rather than a separate subscribe.
    if (hasGitClean) {
      latestGitRows = snap.gitStatus;
    }
    if (hasAgentsIdle) {
      latestJobRows = Array.from(snap.jobs.values());
    }
    void evaluate();
  };

  const onGitRows = (rows: Record<string, unknown>[]): void => {
    latestGitRows = rows as unknown as GitStatus[];
    paintGate.git = true;
    void evaluate();
  };

  const onJobRows = (rows: Record<string, unknown>[]): void => {
    latestJobRows = rows as unknown as Job[];
    paintGate.jobs = true;
    void evaluate();
  };

  const onLifecycle =
    (stream: "readiness" | "git" | "jobs") =>
    (event: string): void => {
      if (event === "disconnected") {
        reconnectStable[stream] = false;
        if (stream === "readiness") {
          for (const slot of slots) {
            if (slot.kind === "planctl") {
              slot.presentThisConnection = false;
            }
          }
        }
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

  // Aggregate timeout fields. Single-planctl is byte-identical; otherwise
  // a generalized shape.
  const timeoutFields = (): Record<string, string> => {
    if (single && slots[0]?.kind === "planctl") {
      const t = slots[0].target;
      return {
        reason: "timeout",
        target: t.id,
        kind: t.kind,
        condition: t.condition,
      };
    }
    return {
      reason: "timeout",
      conditions: slots.map(slotLabel).join(" and "),
    };
  };

  // SIGTERM/SIGINT → failed reason=timeout exit 3 through the same
  // `terminating` guard. Monitor sends SIGTERM at its kill timeout.
  unregisterSignals = deps.installSignals(() => {
    emitTerminal("failed", 3, timeoutFields());
  });

  // Our own --timeout deadline. If both Monitor's kill timeout AND
  // --timeout are set, the smaller wins — by design, --timeout should
  // be set BELOW Monitor's kill so the protocol-shaped line lands
  // before SIGTERM does.
  if (args.timeoutMs !== null && args.timeoutMs > 0) {
    deadlineHandle = deps.setTimer(() => {
      emitTerminal("failed", 3, timeoutFields());
    }, args.timeoutMs);
  }

  // No-git-root: any condition that needs a root but the cwd isn't inside
  // a git worktree → terminal `failed reason=no-git-root` exit 1 at arm
  // time. The side-effect resolve happens in `main`; we just check the
  // injected value here.
  if (needsRoot && deps.gitRoot === null) {
    emitTerminal("failed", 1, {
      reason: "no-git-root",
      conditions: slots.map(slotLabel).join(" and "),
    });
    return state.result;
  }

  // Open ONLY the subscriptions the active conditions need.
  if (openReadiness) {
    readinessHandle = subscribeReadiness({
      sockPath: args.sock,
      idPrefix: `await-${process.pid}`,
      onSnapshot: onReadinessSnapshot,
      onLifecycle: onLifecycle("readiness"),
      onFatal,
      ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    });
  }
  if (openGitCollection) {
    gitHandle = subscribeCollection({
      sockPath: args.sock,
      idPrefix: `await-${process.pid}`,
      collection: "git",
      onRows: onGitRows,
      onLifecycle: onLifecycle("git"),
      onFatal,
      ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    });
  }
  if (openJobsCollection) {
    jobsHandle = subscribeCollection({
      sockPath: args.sock,
      idPrefix: `await-${process.pid}`,
      collection: "jobs",
      onRows: onJobRows,
      onLifecycle: onLifecycle("jobs"),
      onFatal,
      ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    });
  }

  return state.result;
}

// ---------------------------------------------------------------------------
// Side-effect read: cwd → git toplevel (one-shot)
// ---------------------------------------------------------------------------

/**
 * Resolve the cwd to its containing git toplevel via a one-shot
 * `git --no-optional-locks rev-parse --show-toplevel`. Returns `null` when
 * the cwd isn't inside a git worktree (or the spawn fails / times out).
 *
 * Mirrors `src/git-worker.ts`'s `gitOutput` / `resolveGitToplevel` spawn
 * discipline — `--no-optional-locks` (never take `.git/index.lock` as a
 * pure observer) + a bounded timeout — WITHOUT importing the module-private
 * helper. Only called by `main`; the pure await module never touches the
 * filesystem.
 */
function resolveCwdGitRoot(): string | null {
  try {
    const res = Bun.spawnSync(
      ["git", "--no-optional-locks", "rev-parse", "--show-toplevel"],
      { stdout: "pipe", stderr: "ignore", timeout: 2000 },
    );
    if (!res.success || res.exitCode !== 0) {
      return null;
    }
    const root = res.stdout.toString().trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
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

  // Side-effect reads (NOT the pure module): resolve cwd→git root only when
  // a condition needs it, and read the self-exclusion session id once.
  const needsRoot = parsed.args.segments.some(
    (s) => s.condition === "git-clean" || s.condition === "agents-idle",
  );
  const gitRoot = needsRoot ? resolveCwdGitRoot() : null;
  const ownSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;

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
    gitRoot,
    ownSessionId,
  });
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/await.ts` would
// bypass the dispatcher; if you really need it, run
// `bun cli/keeper.ts await <args>` instead.
