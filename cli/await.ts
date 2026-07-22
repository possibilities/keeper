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
 *   0  met (or, under --probe, the condition holds now)
 *   1  not-found / usage / connection fatal / unreachable
 *   3  timeout (our own --timeout deadline)
 *   4  deleted (was on board, vanished, re-query miss)
 *   5  stuck under --fail-on-stuck (default: keep waiting)
 *   9  --probe only: evaluated cleanly, condition does not hold
 *  10  signal (external SIGTERM/SIGINT — Monitor's kill timeout / operator kill)
 *
 * `reason=unreachable` (exit 1) is distinct from `reason=connect`: connect
 * is a terminal query-shape error keeperd rejected; unreachable is the
 * give-up deadline firing because keeperd never painted a first snapshot
 * (down / mid-bounce / half-up). It is OPT-IN ONLY (fn-757): a plain
 * `keeper await` reconnects forever and never emits `unreachable`; pass
 * `--connect-timeout <dur>` to arm the bounded path for a non-interactive /
 * CI caller that wants a give-up deadline. `server-up` is permanently
 * give-up-exempt (reconnect-forever, and `--connect-timeout` is rejected
 * with it at parse time) EXCEPT under `--probe`, which implies its own
 * bounded connect deadline (a probe that hangs on a down daemon defeats
 * its "evaluate once and exit" purpose) — see `--probe` below.
 *
 * `--probe` evaluates the armed condition(s) exactly ONCE, against the
 * first painted snapshot, then exits: 0 when it holds, 9 when it evaluates
 * cleanly and does not (never 124 — that's `timeout(1)`'s GNU collision
 * code). Edge-triggered conditions (`changed` / `epic-added` /
 * `epic-removed`) have no instantaneous truth value and are a usage error
 * (exit 2) under `--probe`. `--probe` implies a bounded connect deadline
 * (default when `--connect-timeout` is unset); an unreachable daemon still
 * reports the existing `reason=unreachable` exit 1 within that deadline,
 * distinct from a clean does-not-hold.
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
 * -emit. SIGTERM/SIGINT route to `failed reason=signal` exit 10 — an
 * external kill, DISTINCT from our own `--timeout` deadline (reason=timeout
 * exit 3) so forensics never confuses a mass-reap for self-deadlines.
 *
 * Reconnect blip is NOT a drop: subscribeReadiness re-gates first-paint
 * on reconnect, and a target absent in the post-reconnect first
 * snapshot is harmless. We only treat a drop as terminal after we've
 * seen the target present in a previous snapshot AND the CURRENT tick
 * is post-reconnect-stable (one full snapshot has landed since the
 * last `connected` lifecycle event).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type AwaitInputs,
  type AwaitState,
  type AwaitTarget,
  advanceCompleteStability,
  agentsIdleState,
  type BoardSignatureInput,
  COMPLETE_DWELL_MS,
  type CompleteStability,
  changedSignature,
  classifyTargetId,
  completeWatermark,
  type DrainedHolder,
  type DrainedJob,
  type DrainedScope,
  drainedState,
  epicAddedMet,
  epicRemovedMet,
  evaluateAwaitCondition,
  gitCleanState,
  initCompleteStability,
  landedState,
  type MonitorSelector,
  monitorRunningState,
  type NeedsHumanSignal,
  needsHumanSignalNeedsFold,
  needsHumanState,
  type PlanCondition,
} from "../src/await-conditions";
import { resolveAwaitSpillDir, resolveSockPath } from "../src/db";
import type { MonitorEntry } from "../src/derivers";
import { projectNeedsHuman } from "../src/needs-human";
import type {
  DurableAwaitCondition,
  DurableAwaitConditionSpec,
} from "../src/protocol";
import type { GiveUpPolicy } from "../src/readiness-client";
import {
  type ConnectFactory,
  type FatalError,
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic, GitStatus, Job } from "../src/types";
import { queryCollection, roundTrip } from "./control-rpc";
import { parseOptions } from "./descriptor";
import { resolveSession } from "./dispatch";
import { parseDuration } from "./duration";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP = `keeper await — block until a plan/git/job condition holds

Usage:
  keeper await <condition> [<id>] [and <condition> [<id>]]... [flags]

Conditions (one per segment; join with the literal 'and' to wait for ALL):
  complete <id>      done-AND-idle: the task/epic is done+approved AND its work
                     session has gone idle, or the epic has popped off the board
  started <id>       work has begun on the task/epic (monotonic milestone)
  unblocked <id>     row is workable now (concurrency mutexes don't block)
  git-clean          cwd's git root has no dirty/orphaned files (no id)
  agents-idle        no OTHER working session inside the git root (no id)
  server-up          keeperd is serving; fires on first snapshot. Reconnects
                     forever; can't be ANDed or use --connect-timeout (no id)
  monitor-running <selector>
                     a background monitor in YOUR session is still running.
                     Selector (exact match): cmd:<command>, kind:<monitor|
                     bash-bg|ambient>, or a bare token (= cmd:<token>).
  drained [--scope S]  no open KEEPER-DISPATCHED work remains (no id). The
                     --scope axis (default plan):
                       plan     (default) only autopilot/escalation sessions
                                count; YOUR own + adopted/external sessions
                                never hold it; still holds on open plan rows +
                                pending dispatches. Means "no open plan work"
                       inflight only running dispatched work + pending
                                dispatches reach zero (ignores ready rows)
                       board    STRICT prior gate — the WHOLE board at rest,
                                every session counts, every row completed
                     --fail-on-stuck → exit 5 on an operator jam sticky (all
                     scopes; an external session never masks a real jam)
  epic-added [id]    an epic appears on the board (optionally a specific id).
                     Edge-triggered: never satisfied on first paint
  epic-removed <id>  the named epic leaves the board (done or deleted).
                     Edge-triggered: never satisfied on first paint
  changed [since:R]  the board's epics/verdicts/autopilot move. Edge-triggered;
                     since:<hash> anchors against a prior 'changed' baseline
  landed <epic>      the epic's work has landed on the LOCAL default branch:
                     finalize merge for a lane, completion for a serial fallback
  <needs-human> [since:S]
                     a needs-human signal is present (level-triggered). Six
                     per-signal tokens — dead-letter, block-escalation,
                     parked-question, stuck-dispatch, finalize-non-ff,
                     instant-death-wall — plus the umbrella needs-human (any of
                     them). stuck-dispatch/finalize-non-ff/instant-death-wall and
                     the umbrella fire on the operator-jam class only (an
                     occupancy sticky never trips them). since:<signature> anchors
                     against a signature a prior met printed: a still-present,
                     already-triaged signal holds; a genuinely new one fires

Flags:
  --durable              Persist a server-evaluable wait and return immediately;
                         keeperd fires its fresh follow-up when it is met
  --timeout <dur>        Own deadline (e.g. 30s, 5m) → reason=timeout exit 3
  --connect-timeout <dur>  Bounded reach-server deadline → reason=unreachable
                         exit 1. Default off = reconnect forever
  --fail-on-stuck        Treat stuck verdicts as terminal exit 5 (else wait)
  --scope <plan|inflight|board>  drained scope (default plan; board = the
                         strict whole-board gate). Inert for other conditions
  --no-armed-line        Suppress the initial armed line
  --heartbeat <dur|off>  Stderr progress line naming the wait's holders on a
                         cadence (default 60s; 'off' silences it)
  --require-transition   A condition true at arm time waits for a real edge
  --probe                Evaluate once against the first snapshot and exit:
                         0 holds, 9 evaluated-clean-does-not-hold. Implies a
                         bounded connect deadline. Rejects edge-triggered
                         conditions (changed/epic-added/epic-removed)
  --json                 Emit armed/terminal lines as JSON
  --sock <path>          Socket override ($KEEPER_SOCK / default)
  --help                 Show this help

Exit codes:
  0 met (or, under --probe, holds now)
  1 not-found / no-match / no-git-root / usage / connect / unreachable
  3 timeout    4 deleted    5 stuck (only under --fail-on-stuck)
  9 --probe only: evaluated cleanly, condition does not hold
  10 signal (external SIGTERM/SIGINT — e.g. Monitor's kill timeout)

Examples:
  keeper await complete fn-12-add-oauth.3
  keeper await git-clean and agents-idle
  keeper await drained --probe        # one-shot check; 0 holds, 9 does not

Reason glossary, reconnect/give-up semantics, and the agent workflow live in
skills/await/SKILL.md.
`;

/** Terse operator runbook (agent-facing), distinct from the full `--help`. */
export const AGENT_HELP = `keeper await — operator runbook (agent-facing)

Block until a plan/git/job condition holds, then act. Join conditions with the
literal 'and' to wait for ALL. Durations are unit-required (30s, 5m).

  keeper await complete fn-N.M            # task/epic done+approved AND its session idle
  keeper await landed fn-N                # epic's work landed on LOCAL default
  keeper await git-clean and agents-idle  # cwd's git root quiet + no OTHER working session
  keeper await drained                    # no open keeper-dispatched work (plan scope — the default)
  keeper await drained --scope board --fail-on-stuck  # STRICT: whole board at rest; exit 5 on a jam
  keeper await server-up                  # keeperd is serving (reconnects forever)
  keeper await needs-human                # ANY needs-human signal present (umbrella)
  keeper await stuck-dispatch since:S     # re-arm anti-spin: fire only on a NEW signal
  keeper await <cond> --timeout 5m --json # own deadline + JSON envelope lines
  keeper await drained --probe            # one-shot: "would this fire now?" 0 holds, 9 does not

drained --scope axis (default plan): plan waits on open KEEPER-DISPATCHED work only —
autopilot + escalation (unblock/deconflict/resolve/repair) sessions, YOUR own session and
every adopted/external session excluded — plus open plan rows + pending dispatches; this is
"no open plan work left". inflight waits only for running dispatched work + pending
dispatches to hit zero (ignores ready-but-undispatched rows — pair it with a paused board).
board is the STRICT prior gate: the WHOLE board at rest, every session counts. The default
FLIPPED to plan — a caller that needs the whole-board gate MUST say --scope board (the watch
wedge alarm does). --fail-on-stuck fires on an operator jam under every scope.

Needs-human signals (level-triggered presence; ANDable): the six per-signal tokens
dead-letter · block-escalation · parked-question · stuck-dispatch · finalize-non-ff ·
instant-death-wall, plus the umbrella needs-human (any of them). The dispatch trio
(stuck-dispatch/finalize-non-ff/instant-death-wall) and the umbrella fire on the
OPERATOR-JAM class only, deriving from the shared status/watch/await projector — an
occupancy / self-clearing sticky inflates the broad status count but never trips an
await. Each accepts an optional since:<signature>: a still-present, already-triaged
signal whose signature matches the anchor HOLDS (anti-spin), while a genuinely new
signal set (signature moved) FIRES. Every met envelope carries the current signature —
capture it to re-arm. Arming a per-signal token AND the umbrella wakes twice for one
event (an intended choice). since: is the preferred re-arm idiom over --require-transition
(which applies per-slot as always: a condition true at arm time waits for the next edge).

--probe answers "would this fire now, and why not" without blocking: evaluates every
segment once against the first painted snapshot, prints one envelope naming each slot's
state (plus drained-family holders), and exits — 0 when every slot holds, 9 when it
evaluated cleanly and does not (documented registry code, never 124 — that's
timeout(1)'s GNU collision). Implies its own bounded connect deadline (default when
--connect-timeout is unset) — a down daemon still reports reason=unreachable exit 1
within that deadline, distinct from a clean does-not-hold. Edge-triggered conditions
(changed/epic-added/epic-removed) have no instantaneous truth value and are a usage
error under --probe. A stuck plan/drained verdict under --probe --fail-on-stuck still
surfaces as its own exit 5, not folded into the generic does-not-hold.

Exit codes: 0 met (or --probe holds) · 1 not-found/usage/connect/unreachable · 3 timeout
· 4 target deleted · 5 stuck (only under --fail-on-stuck) · 9 --probe only: evaluated
cleanly, does not hold · 10 signal (external SIGTERM/SIGINT). Footguns: server-up can't be ANDed or take an explicit
--connect-timeout (no id) — under bare --probe it still gets a bounded deadline (the
probe default), only the explicit flag combo is rejected; epic-added/epic-removed/changed
are edge-triggered (never fire on first paint, and are a usage error under --probe);
'complete' is done+idle; 'landed' confirms work reached the default branch by
finalize merge or completed serial execution.
`;

// ---------------------------------------------------------------------------
// Sanitization for the stdout event channel
// ---------------------------------------------------------------------------

/**
 * Strip CR/LF from a value so an embedded newline can't spoof an
 * adjacent `[keeper-await] …` event.
 */
function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]/g, " ");
}

/**
 * fn-941: project the readiness snapshot's `block_escalations` latch rows into
 * the coarse "escalation in flight" set of task ids `evaluateAwaitCondition`
 * consumes — a row's PRESENCE for a task means a planner has been / is being
 * notified, read as a yes/no rather than the latch's internal state machine.
 */
function escalatedTaskIdsOf(
  snap: ReadinessClientSnapshot,
): ReadonlySet<string> {
  return new Set(snap.blockEscalations.map((e) => e.task_id));
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
  fields: Record<string, string | string[]>,
): string {
  if (json) {
    const sanitized: Record<string, string | string[]> = { event };
    for (const [k, v] of Object.entries(fields)) {
      sanitized[k] = Array.isArray(v) ? v.map(sanitizeValue) : sanitizeValue(v);
    }
    return `${JSON.stringify(sanitized)}\n`;
  }
  const parts: string[] = [`[keeper-await] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    const rendered = Array.isArray(v)
      ? v.map(sanitizeValue).join(",")
      : sanitizeValue(v);
    parts.push(`${k}=${rendered}`);
  }
  return `${parts.join(" ")}\n`;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * One parsed condition segment. The two plan families carry an
 * {@link AwaitTarget} (id + kind + condition); `git-clean` / `agents-idle`
 * carry only the condition tag.
 */
export type ConditionSegment =
  | { condition: PlanCondition; target: AwaitTarget }
  | { condition: "git-clean" }
  | { condition: "agents-idle" }
  | { condition: "server-up" }
  | { condition: "monitor-running"; selector: MonitorSelector; raw: string }
  // fn-1015 board-level conditions (read the whole board off the readiness
  // snapshot; no plan target presence semantics).
  | { condition: "drained" }
  | { condition: "changed"; since?: string }
  | { condition: "epic-added"; target?: string }
  | { condition: "epic-removed"; target: string }
  // `landed <epic>` — the work-on-default milestone. A board-family condition
  // (reads the whole-board `landedEpicIds` set off the
  // readiness snapshot), but carrying a required epic target like
  // `epic-removed`.
  | { condition: "landed"; target: string }
  // fn-1150 needs-human conditions — the six per-signal tokens plus the umbrella.
  // Board-family (read the whole board off the readiness snapshot), no id, each
  // carrying an OPTIONAL `since:<signature>` anti-spin anchor (mirrors `changed`).
  | { condition: NeedsHumanSignal; since?: string };

export interface ParsedArgs {
  /** One or more condition segments, ANDed. Always >= 1. */
  segments: ConditionSegment[];
  timeoutMs: number | null;
  /**
   * Opt-in reach-the-server give-up deadline (fn-757). `null`/`0` =
   * reconnect forever (the default). When `> 0`, await arms the bounded
   * `reason=unreachable` path; mutually exclusive with `server-up`.
   */
  connectTimeoutMs: number | null;
  failOnStuck: boolean;
  /**
   * The `drained` scope axis (ADR 0032). Bare `drained` defaults to `plan`
   * (keeper-dispatched work only, caller self-excluded); `board` is the strict
   * prior gate. Inert for every non-`drained` condition.
   */
  scope: DrainedScope;
  noArmedLine: boolean;
  requireTransition: boolean;
  json: boolean;
  sock: string;
  /**
   * Wall-clock heartbeat cadence (task 2): a periodic STDERR-only progress
   * line naming what currently holds the wait, so a long silent wait stays
   * legible. Defaults to 60s when `--heartbeat` is omitted; `--heartbeat off`
   * disables it (`null`); `--heartbeat <dur>` sets a custom cadence. Never
   * touches the byte-stable stdout terminal contract.
   */
  heartbeatMs: number | null;
  /**
   * One-shot mode (task 3): evaluate every segment ONCE against the first
   * painted snapshot, emit a `probe` envelope naming each slot's state (plus
   * drained-family holders), and exit — 0 when every slot holds, the
   * additive `EXIT_PROBE_DOES_NOT_HOLD` when it evaluates cleanly and does
   * not. Rejected at parse time alongside an edge-triggered segment
   * (`changed` / `epic-added` / `epic-removed`), which has no instantaneous
   * truth value. Implies a bounded connect deadline (an explicit
   * `--connect-timeout` still wins) — see `runAwait`'s `giveUpExtras`.
   */
  probe: boolean;
  /** Persist this server-evaluable wait and return instead of blocking. */
  durable?: boolean;
}

/**
 * fn-775: the bounded give-up deadline for a scope-exempt re-query one-shot.
 * The re-query rides the same retryable-cap-reject path as the main
 * subscriptions (a `max_connections` reject reconnects rather than firing
 * `onFatal`), but a one-shot CANNOT reconnect-forever — it must resolve so
 * `evaluate()` can proceed. So it carries a short give-up deadline: if a cap
 * reject keeps it unpainted past this window, the give-up driver fires
 * `onFatal({code:"unreachable"})` and the one-shot resolves INDETERMINATE
 * (never `deleted`). The next steady-poll absent-transition re-triggers the
 * re-query, so a transient cap squeeze defers rather than committing a false
 * deletion. Modest (a few capped backoffs' worth) so a genuinely-down daemon
 * doesn't stall the verdict for long.
 */
const REQUERY_GIVE_UP_MS = 6000;

/**
 * fn-775: scope-exempt re-query verdict. `hit`/`miss` are confirmed
 * present/absent; `indeterminate` means a `max_connections` cap reject kept
 * the one-shot unpainted past its bounded deadline — the verifier could not
 * confirm deletion, so the caller defers (stays armed) rather than committing
 * a false `deleted`.
 */
type ReQueryOutcome = "hit" | "miss" | "indeterminate";

/** Conditions that take exactly one plan id positional. */
const PLAN_CONDITIONS: ReadonlySet<string> = new Set([
  "complete",
  "unblocked",
  "started",
]);
/** Conditions that take NO positional arg. */
const NULLARY_CONDITIONS: ReadonlySet<string> = new Set([
  "git-clean",
  "agents-idle",
  "server-up",
]);
/** Conditions that take EXACTLY ONE selector token (a third arity bucket). */
const SELECTOR_CONDITIONS: ReadonlySet<string> = new Set(["monitor-running"]);
/**
 * fn-1150 needs-human tokens — the six per-signal families plus the umbrella.
 * Each takes NO id and an OPTIONAL `since:<signature>` anti-spin anchor (same
 * arity as `changed`). Kept as the {@link NeedsHumanSignal} member set so the
 * parse branch, the board-slot wiring, and the derived `includeDispatchFailures`
 * opt-in all key off ONE list.
 */
const NEEDS_HUMAN_SIGNALS: ReadonlySet<NeedsHumanSignal> = new Set([
  "dead-letter",
  "block-escalation",
  "parked-question",
  "stuck-dispatch",
  "finalize-non-ff",
  "instant-death-wall",
  "needs-human",
]);

/** True iff `c` is one of the seven needs-human condition tokens. */
function isNeedsHumanCondition(c: string): c is NeedsHumanSignal {
  return (NEEDS_HUMAN_SIGNALS as ReadonlySet<string>).has(c);
}

/** The three valid `kind:` provenance values for a monitor selector. */
const MONITOR_KINDS: ReadonlySet<MonitorEntry["kind"]> = new Set([
  "monitor",
  "bash-bg",
  "ambient",
]);

/**
 * Parse one `monitor-running` selector token (fn-718, T3) into a
 * {@link MonitorSelector}. Three accepted forms, all EXACT-match (the
 * predicate never does substring/regex):
 *
 *   - `cmd:<command>` → match the FULL command string (`{ command }`).
 *   - `kind:<kind>`   → match the provenance enum, one of `monitor` /
 *                       `bash-bg` / `ambient` (`{ kind }`).
 *   - `<bare token>`  → shorthand for `cmd:<token>` (command-match default).
 *
 * Returns `null` on a malformed selector — an empty token, an empty
 * `cmd:`/`kind:` value, or a `kind:` whose value isn't one of the three
 * enum members. The caller converts `null` to a usage error. A bare token
 * is NEVER rejected here (any non-empty string is a valid command match);
 * the arm-time refuse-upfront pre-check is what catches a command that
 * matches no live monitor.
 */
export function parseMonitorSelector(token: string): MonitorSelector | null {
  if (token.length === 0) {
    return null;
  }
  if (token.startsWith("cmd:")) {
    const command = token.slice("cmd:".length);
    return command.length > 0 ? { command } : null;
  }
  if (token.startsWith("kind:")) {
    const kind = token.slice("kind:".length);
    if ((MONITOR_KINDS as ReadonlySet<string>).has(kind)) {
      return { kind: kind as MonitorEntry["kind"] };
    }
    return null;
  }
  // Bare token → command-match default.
  return { command: token };
}

/** Exit code for a usage/grammar fault (a bad flag value). */
const EXIT_USAGE = 2;

/** Default `--heartbeat` cadence (task 2) when the flag is omitted: on, ~60s. */
const DEFAULT_HEARTBEAT_MS = 60_000;

/**
 * `--probe`'s additive terminal code (task 3, registered in `cli/keeper.ts`'s
 * `EXIT_CODES` and mirrored in `cli/descriptor.ts`'s await `exit_codes`):
 * every segment evaluated cleanly against the first painted snapshot and did
 * NOT hold. Frozen 3/4/5 stay untouched; deliberately not 124 (GNU
 * `timeout(1)`'s "still running" collision).
 */
const EXIT_PROBE_DOES_NOT_HOLD = 9;

/**
 * External-signal terminal code: a SIGTERM/SIGINT killed the await from
 * OUTSIDE (Monitor's kill timeout, an operator kill), a DISTINCT verdict
 * from the caller's own `--timeout` deadline (exit 3) so a mass-reap is
 * never mistaken for a wave of self-deadlines. Registered in
 * `cli/keeper.ts`'s `EXIT_CODES` and mirrored in `cli/descriptor.ts`'s await
 * `exit_codes`; not 124 (GNU `timeout(1)` collision), not the frozen 3/4/5/6/9.
 */
const EXIT_SIGNAL = 10;

/**
 * `--probe`'s implied connect deadline (task 3) when `--connect-timeout` is
 * NOT explicitly set — a probe that reconnects forever on a down daemon
 * defeats its "evaluate once and exit" purpose. An explicit
 * `--connect-timeout` always wins over this default.
 */
const PROBE_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

interface ParseFailure {
  ok: false;
  message: string;
  /** Process exit code for `main` (default 1); a bad duration is a usage
   *  fault → exit 2 under the shared grammar. */
  exitCode?: number;
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
      // Derived from the pure-data descriptor (ADR 0008).
      options: parseOptions("await"),
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
  if (values["agent-help"] === true) {
    return { ok: false, message: "__agent_help__" };
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
    if (PLAN_CONDITIONS.has(condRaw)) {
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
      const condition = condRaw as PlanCondition;
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
      segments.push({
        condition: condRaw as "git-clean" | "agents-idle" | "server-up",
      });
    } else if (SELECTOR_CONDITIONS.has(condRaw)) {
      if (rest.length !== 1) {
        return {
          ok: false,
          message: `condition '${condRaw}' takes exactly one selector (got ${rest.length})`,
        };
      }
      const rawSelector = rest[0] ?? "";
      const selector = parseMonitorSelector(rawSelector);
      if (selector === null) {
        return {
          ok: false,
          message: `invalid selector '${rawSelector}' for '${condRaw}' (expected cmd:<command>, kind:<monitor|bash-bg|ambient>, or a bare command token)`,
        };
      }
      const dupKey = `${condRaw}:${rawSelector}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({
        condition: "monitor-running",
        selector,
        raw: rawSelector,
      });
    } else if (condRaw === "drained") {
      if (rest.length !== 0) {
        return {
          ok: false,
          message: `condition 'drained' takes no id (got ${rest.length} extra arg(s))`,
        };
      }
      if (seen.has("drained")) {
        return { ok: false, message: "duplicate condition 'drained'" };
      }
      seen.add("drained");
      segments.push({ condition: "drained" });
    } else if (condRaw === "changed") {
      if (rest.length > 1) {
        return {
          ok: false,
          message: `condition 'changed' takes at most one since:<hash> token (got ${rest.length})`,
        };
      }
      let since: string | undefined;
      if (rest.length === 1) {
        const tok = rest[0] ?? "";
        if (!tok.startsWith("since:")) {
          return {
            ok: false,
            message: `invalid arg '${tok}' for 'changed' (expected since:<hash>)`,
          };
        }
        since = tok.slice("since:".length);
        if (since.length === 0) {
          return {
            ok: false,
            message:
              "condition 'changed' since:<hash> requires a non-empty hash",
          };
        }
      }
      const dupKey = since === undefined ? "changed" : `changed:${since}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({
        condition: "changed",
        ...(since === undefined ? {} : { since }),
      });
    } else if (condRaw === "epic-added") {
      if (rest.length > 1) {
        return {
          ok: false,
          message: `condition 'epic-added' takes at most one id (got ${rest.length})`,
        };
      }
      let target: string | undefined;
      if (rest.length === 1) {
        target = rest[0] ?? "";
        if (classifyTargetId(target) !== "epic") {
          return {
            ok: false,
            message: `condition 'epic-added' id '${target}' must be an epic id (fn-N or fn-N-slug)`,
          };
        }
      }
      const dupKey =
        target === undefined ? "epic-added" : `epic-added:${target}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({
        condition: "epic-added",
        ...(target === undefined ? {} : { target }),
      });
    } else if (condRaw === "epic-removed") {
      if (rest.length !== 1) {
        return {
          ok: false,
          message: `condition 'epic-removed' takes exactly one id (got ${rest.length})`,
        };
      }
      const target = rest[0] ?? "";
      if (classifyTargetId(target) !== "epic") {
        return {
          ok: false,
          message: `condition 'epic-removed' id '${target}' must be an epic id (fn-N or fn-N-slug)`,
        };
      }
      const dupKey = `epic-removed:${target}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({ condition: "epic-removed", target });
    } else if (condRaw === "landed") {
      // fn-1016: `landed <epic>` — lanes are per-epic, so a task id is a usage
      // error (mirrors `epic-removed`'s epic-only guard).
      if (rest.length !== 1) {
        return {
          ok: false,
          message: `condition 'landed' takes exactly one id (got ${rest.length})`,
        };
      }
      const target = rest[0] ?? "";
      if (classifyTargetId(target) !== "epic") {
        return {
          ok: false,
          message: `condition 'landed' id '${target}' must be an epic id (fn-N or fn-N-slug)`,
        };
      }
      const dupKey = `landed:${target}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({ condition: "landed", target });
    } else if (isNeedsHumanCondition(condRaw)) {
      // fn-1150: the six per-signal needs-human tokens + the umbrella. Each takes
      // NO id and an OPTIONAL `since:<signature>` anti-spin anchor (mirrors the
      // `changed since:<hash>` grammar).
      if (rest.length > 1) {
        return {
          ok: false,
          message: `condition '${condRaw}' takes at most one since:<signature> token (got ${rest.length})`,
        };
      }
      let since: string | undefined;
      if (rest.length === 1) {
        const tok = rest[0] ?? "";
        if (!tok.startsWith("since:")) {
          return {
            ok: false,
            message: `invalid arg '${tok}' for '${condRaw}' (expected since:<signature>)`,
          };
        }
        since = tok.slice("since:".length);
        if (since.length === 0) {
          return {
            ok: false,
            message: `condition '${condRaw}' since:<signature> requires a non-empty value`,
          };
        }
      }
      const dupKey = since === undefined ? condRaw : `${condRaw}:${since}`;
      if (seen.has(dupKey)) {
        return { ok: false, message: `duplicate condition '${dupKey}'` };
      }
      seen.add(dupKey);
      segments.push({
        condition: condRaw,
        ...(since === undefined ? {} : { since }),
      });
    } else {
      return {
        ok: false,
        message: `unknown condition '${condRaw}' (expected complete, unblocked, started, git-clean, agents-idle, server-up, monitor-running, drained, changed, epic-added, epic-removed, landed, dead-letter, block-escalation, parked-question, stuck-dispatch, finalize-non-ff, instant-death-wall, needs-human)`,
      };
    }
  }

  // `server-up` is mutually exclusive with every other condition: it has
  // its own give-up-exempt reconnect-forever subscribe path and fires on
  // first paint, so ANDing it with a board/git/jobs condition is incoherent
  // (and would drag a give-up-bearing handle alongside a give-up-exempt one).
  // The existing dup-guard only blocks IDENTICAL conditions; this is net-new
  // exclusivity logic. Rejected at parse time either ordering.
  if (
    segments.length > 1 &&
    segments.some((s) => s.condition === "server-up")
  ) {
    return {
      ok: false,
      message: "condition 'server-up' cannot be combined with 'and'",
    };
  }

  // `--connect-timeout` arms the bounded `reason=unreachable` give-up path,
  // which `server-up` is permanently exempt from (reconnect-forever). The two
  // are incoherent together, so reject at parse time (fn-757) — alongside the
  // server-up exclusivity check above.
  if (
    typeof values["connect-timeout"] === "string" &&
    segments.some((s) => s.condition === "server-up")
  ) {
    return {
      ok: false,
      message:
        "condition 'server-up' cannot be combined with --connect-timeout",
    };
  }

  // `--probe` (task 3) evaluates the armed condition(s) exactly ONCE, against
  // the first painted snapshot — the edge-triggered family (`changed` /
  // `epic-added` / `epic-removed`) has no instantaneous truth value (its
  // whole meaning is a DELTA against a captured baseline), so it's a usage
  // error under probe rather than a silent forever-"does not hold".
  if (values.probe === true) {
    const edgeTriggered = segments.find(
      (s) =>
        s.condition === "changed" ||
        s.condition === "epic-added" ||
        s.condition === "epic-removed",
    );
    if (edgeTriggered !== undefined) {
      return {
        ok: false,
        message: `condition '${edgeTriggered.condition}' has no instantaneous truth value under --probe (edge-triggered)`,
        exitCode: EXIT_USAGE,
      };
    }
  }

  let timeoutMs: number | null = null;
  const timeoutRaw = values.timeout;
  if (typeof timeoutRaw === "string" && timeoutRaw.length > 0) {
    const parsed = parseDuration(timeoutRaw);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `--timeout ${parsed.message}`,
        exitCode: EXIT_USAGE,
      };
    }
    timeoutMs = parsed.ms;
  }

  // `--connect-timeout` clones the `--timeout` parse-and-validate block,
  // reusing the shared duration grammar. Absent = reconnect forever.
  let connectTimeoutMs: number | null = null;
  const connectTimeoutRaw = values["connect-timeout"];
  if (typeof connectTimeoutRaw === "string" && connectTimeoutRaw.length > 0) {
    const parsed = parseDuration(connectTimeoutRaw);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `--connect-timeout ${parsed.message}`,
        exitCode: EXIT_USAGE,
      };
    }
    connectTimeoutMs = parsed.ms;
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  // The `drained` scope axis (ADR 0032). Default `plan`; `board` is the strict
  // prior gate. Validated here so a typo fails usage rather than silently
  // reading as `plan`. Inert for every non-`drained` condition.
  let scope: DrainedScope = "plan";
  const scopeRaw = values.scope;
  if (scopeRaw !== undefined) {
    if (
      scopeRaw !== "plan" &&
      scopeRaw !== "inflight" &&
      scopeRaw !== "board"
    ) {
      return {
        ok: false,
        message: `--scope must be plan|inflight|board (got '${String(scopeRaw)}')`,
        exitCode: EXIT_USAGE,
      };
    }
    scope = scopeRaw;
  }

  // `--heartbeat <dur|off>` (task 2): defaults ON at DEFAULT_HEARTBEAT_MS
  // when omitted; the literal `off` disables it (`null`); otherwise the
  // shared duration grammar, same fault shape as `--timeout`.
  let heartbeatMs: number | null = DEFAULT_HEARTBEAT_MS;
  const heartbeatRaw = values.heartbeat;
  if (typeof heartbeatRaw === "string" && heartbeatRaw.length > 0) {
    if (heartbeatRaw === "off") {
      heartbeatMs = null;
    } else {
      const parsed = parseDuration(heartbeatRaw);
      if (!parsed.ok) {
        return {
          ok: false,
          message: `--heartbeat ${parsed.message}`,
          exitCode: EXIT_USAGE,
        };
      }
      heartbeatMs = parsed.ms;
    }
  }

  return {
    ok: true,
    args: {
      segments,
      timeoutMs,
      connectTimeoutMs,
      failOnStuck: values["fail-on-stuck"] === true,
      scope,
      noArmedLine: values["no-armed-line"] === true,
      requireTransition: values["require-transition"] === true,
      json: values.json === true,
      sock,
      heartbeatMs,
      probe: values.probe === true,
      durable: values.durable === true,
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
   * Register a one-shot SIGTERM/SIGINT handler; the handler receives the
   * killing signal's NAME (`"SIGTERM"` / `"SIGINT"`) so the terminal line
   * can report WHICH signal. Returns an unregister function so the runner
   * can detach on terminate. Tests inject a controllable handler.
   */
  installSignals: (handler: (signal: string) => void) => () => void;
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
   * pure plan invocation tolerates `null`.
   */
  gitRoot: string | null;
  /**
   * The caller's own `CLAUDE_CODE_SESSION_ID` (fn-713), read once at
   * startup for `agents-idle` self-exclusion. `null` when unset (the
   * self-exclusion becomes a no-op).
   */
  ownSessionId: string | null;
  /**
   * Optional injectable clock (unix ms) forwarded to the give-up-eligible
   * subscribe handles (fn-750.2). The continuous-unpainted give-up deadline
   * is measured against THIS, so the fake-timer test harness can drive the
   * `reason=unreachable` path deterministically. Production omits it (the
   * helper defaults to `Date.now`). NOT forwarded to the `server-up` stream
   * — that one carries no give-up policy.
   */
  now?: () => number;
}

/**
 * Result the runner returns to the harness for assertions. Production
 * never observes this — `exit()` runs before the function returns
 * normally. Tests inject a thrower into `exit` and read the result via
 * the caller's captured state.
 */
export interface RunResult {
  /** Did the await latch armed? Latches regardless of `--no-armed-line`. */
  armed: boolean;
  /** Terminal line text (post-sanitize), or null if none emitted yet. */
  terminalLine: string | null;
  /** Exit code that was passed to `exit()`. */
  exitCode: number | null;
}

/**
 * Per-plan-slot mutable state. Each `complete`/`unblocked` segment
 * keeps its own presence / re-query / reconnect machinery so the
 * single-segment path stays byte-identical and a multi-segment AND
 * tracks each plan target independently.
 */
interface PlanSlotState {
  readonly kind: "plan";
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
  /**
   * `complete`-condition dwell confirmation across subscribe snapshots and the
   * bounded re-evaluation timer. The done-AND-idle `completed` verdict can flap
   * back to `running` when a done task's owning worker re-activates during
   * close-out reconciliation, so `met` is withheld until the completion holds
   * `completed` at a stable row version for `COMPLETE_DWELL_MS` — a quiet board
   * confirms via the timer with no second frame, a flap's version bump restarts
   * the dwell. Inert for `unblocked`/`started` slots (never advanced off a
   * non-`complete` target).
   */
  completeStability: CompleteStability;
}

/**
 * Per-git/jobs-slot mutable state. Simpler than the plan slot — these
 * families have no `deleted`/`stuck` semantic; an absent row is MET, so
 * the slot only latches `met` plus a per-slot verdict-change throttle.
 */
interface GitJobSlotState {
  readonly kind: "git-clean" | "agents-idle";
  met: boolean;
  lastEval: AwaitState | null;
  lastVerdictPhrase: string | null;
}

/**
 * Per-monitor-running-slot mutable state (fn-718, T3). Like
 * {@link GitJobSlotState} it has no `deleted`/`stuck` semantic (absence ==
 * done), but it carries the parsed {@link MonitorSelector} plus the raw
 * selector token for the line render and the arm-time refuse-upfront
 * pre-check.
 */
interface MonitorSlotState {
  readonly kind: "monitor-running";
  readonly selector: MonitorSelector;
  readonly raw: string;
  met: boolean;
  lastEval: AwaitState | null;
  lastVerdictPhrase: string | null;
}

/**
 * Per-server-up-slot mutable state (fn-750.2). The minimal nullary slot:
 * it carries no rows and no pure evaluator — `met` latches the instant the
 * first readiness snapshot lands (first-paint == "the daemon is serving").
 * Always the SOLE slot (parse rejects ANDing it), so the AND machinery is
 * trivially satisfied once it's met.
 */
interface ServerUpSlotState {
  readonly kind: "server-up";
  met: boolean;
  lastEval: AwaitState | null;
  lastVerdictPhrase: string | null;
}

/**
 * Per-board-slot mutable state (fn-1015) — `drained` / `changed` /
 * `epic-added` / `epic-removed`. Reads the whole board off the readiness
 * snapshot (plus the boot-status `catching_up` and, for `drained
 * --fail-on-stuck`, the live `dispatch_failures` rows). No `deleted`/`stuck`
 * re-query (a board condition has no plan-target presence); `drained` reaches
 * `stuck` purely through its pure predicate, never a re-query.
 *
 * The edge-triggered conditions (`changed`/`epic-added`/`epic-removed`) capture
 * a FIRST-PAINT baseline (`baselineEpicIds` / `baselineSignature`) once
 * (`baselineCaptured` latches and is NEVER reset on reconnect — the anchor is
 * last-known content, not connection lifecycle), then fire `met` on the first
 * qualifying delta against it. `drained` is level-triggered and ignores the
 * baseline.
 */
interface BoardSlotState {
  readonly kind:
    | "drained"
    | "changed"
    | "epic-added"
    | "epic-removed"
    | "landed"
    // fn-1150 needs-human conditions — level-triggered presence off the shared
    // projector; carry `since` (the anti-spin anchor) but no `target` / baseline.
    | NeedsHumanSignal;
  /**
   * epic id for `epic-added` (optional) / `epic-removed` (required) /
   * `landed` (required, fn-1016).
   */
  readonly target?: string;
  /** `changed since:<hash>` anchor — overrides the first-paint baseline. For a
   *  needs-human slot, the `since:<signature>` anti-spin anchor. */
  readonly since?: string;
  met: boolean;
  lastEval: AwaitState | null;
  lastVerdictPhrase: string | null;
  baselineCaptured: boolean;
  baselineEpicIds: string[];
  baselineSignature: string | null;
}

type SlotState =
  | PlanSlotState
  | GitJobSlotState
  | MonitorSlotState
  | ServerUpSlotState
  | BoardSlotState;

/**
 * Narrow a slot to a {@link BoardSlotState} — the whole-board family (`drained` /
 * `changed` / `epic-added` / `epic-removed` / `landed`) plus the fn-1150
 * needs-human conditions. One guard so the emit/eval sites recognize every board
 * kind without re-enumerating the union at each call.
 */
function isBoardSlot(slot: SlotState): slot is BoardSlotState {
  return (
    slot.kind === "drained" ||
    slot.kind === "changed" ||
    slot.kind === "epic-added" ||
    slot.kind === "epic-removed" ||
    slot.kind === "landed" ||
    isNeedsHumanCondition(slot.kind)
  );
}

/** Narrow a board-slot kind to a {@link NeedsHumanSignal}. */
function isNeedsHumanKind(k: BoardSlotState["kind"]): k is NeedsHumanSignal {
  return isNeedsHumanCondition(k);
}

interface RunnerState {
  terminating: boolean;
  armed: boolean;
  result: RunResult;
}

/**
 * Project the wire `jobs` snapshot into the {@link DrainedJob} set the `drained`
 * predicate weighs: every `state === "working"` row, carrying the real
 * `dispatch_origin` the `plan`/`inflight` scopes gate on (the scope's provenance
 * + self-exclusion filter lives in {@link drainedState}, never here). Sourced off
 * the shared jobs wire, so `dispatch_origin` MUST be a served `JOBS_DESCRIPTOR`
 * column — an unserved column reads back `undefined` → `null` and every job looks
 * manual. Exported so the projection is driven against REAL wire rows, not a
 * fixture that injects the field.
 */
export function projectDrainedRunningJobs(jobs: Iterable<Job>): DrainedJob[] {
  const runningJobs: DrainedJob[] = [];
  for (const job of jobs) {
    if (job.state === "working") {
      runningJobs.push({
        jobId: job.job_id,
        dispatchOrigin: job.dispatch_origin ?? null,
        label: job.title ?? job.job_id,
      });
    }
  }
  return runningJobs;
}

/**
 * Run the await loop. Returns the result struct AFTER `exit()` has
 * fired (tests resolve via captured state). Production `exit()` calls
 * `process.exit` which never returns, so this fn never returns there.
 *
 * Generalized to N latched condition slots (fn-713): one slot per
 * `args.segments` entry. The aggregate emits a single terminal `met` only
 * when EVERY slot is simultaneously met; any plan sub-condition going
 * `not-found`/`deleted`/`stuck`(under `--fail-on-stuck`) short-circuits the
 * whole process. A single plan segment reproduces the pre-fn-713 line
 * shape + exit codes byte-for-byte.
 */
export async function runAwait(
  args: ParsedArgs,
  deps: RunDeps,
): Promise<RunResult> {
  const single = args.segments.length === 1;

  // Which subscription streams do we need? plan → subscribeReadiness
  // (it also exposes raw git/jobs rows, so a plan-bearing combo reads
  // git/jobs off the one snapshot and skips the extra subscribe). git/jobs
  // WITHOUT any plan segment → dedicated subscribeCollection streams.
  const hasPlan = args.segments.some(
    (s) =>
      s.condition === "complete" ||
      s.condition === "unblocked" ||
      s.condition === "started",
  );
  // fn-1015: a `complete` condition reads the done-AND-idle verdict, which for
  // an epic lives on the close-row that only stays observable when the recently-
  // done epics are merged into the readiness scope. Opt the readiness stream
  // into that merge ONLY when a `complete` segment is present — `unblocked` /
  // `started` keep the byte-identical board/dash scope.
  const hasComplete = args.segments.some((s) => s.condition === "complete");
  const hasGitClean = args.segments.some((s) => s.condition === "git-clean");
  const hasAgentsIdle = args.segments.some(
    (s) => s.condition === "agents-idle",
  );
  const hasMonitorRunning = args.segments.some(
    (s) => s.condition === "monitor-running",
  );
  // `server-up` (fn-750.2) is a dedicated minimal subscribe: it needs a
  // CONNECTION but NO git root / plan / jobs rows, and it fires `met` on
  // first paint. It's always the SOLE segment (parse rejects ANDing it), so
  // it doesn't combine with any other stream. It is PERMANENTLY give-up-exempt
  // — reconnect-forever — so it survives a daemon bounce. (fn-757: every
  // stream is now give-up-exempt by default; `--connect-timeout` re-arms a
  // bounded deadline for the give-up-eligible streams but is rejected with
  // server-up at parse time.)
  const hasServerUp = args.segments.some((s) => s.condition === "server-up");
  // fn-1015 board conditions all read off the readiness snapshot. `drained`
  // additionally needs the boot-status `catching_up` flag (latched via
  // `onBootStatus`) and, under `--fail-on-stuck`, the sticky `dispatch_failures`
  // rows — which ride the SAME readiness snapshot via the `includeDispatchFailures`
  // opt-in (ADR 0011), no bespoke collection subscribe.
  const hasDrained = args.segments.some((s) => s.condition === "drained");
  // fn-1016: `landed` reads the whole-board `landedEpicIds` set, so it rides
  // the readiness stream like the other board conditions — BUT that set is only
  // populated under the `includeRecentDoneEpics` opt-in (task-1's
  // `computeLandedEpicIds` gates on it for the OFF degradation), so it shares
  // `complete`'s recent-done opt-in below.
  const hasLanded = args.segments.some((s) => s.condition === "landed");
  // fn-1150: the needs-human conditions read the whole board off the readiness
  // snapshot (the shared projector's counts + jam classification), so they open
  // the readiness stream like the other board conditions.
  const hasNeedsHuman = args.segments.some((s) =>
    isNeedsHumanCondition(s.condition),
  );
  const hasBoard =
    args.segments.some(
      (s) =>
        s.condition === "drained" ||
        s.condition === "changed" ||
        s.condition === "epic-added" ||
        s.condition === "epic-removed" ||
        s.condition === "landed",
    ) || hasNeedsHuman;
  // ADR 0011: `drained --fail-on-stuck` reads the sticky `dispatch_failures`
  // rows for its jam check. This gates the readiness `includeDispatchFailures`
  // opt-in (the rows ride the shared snapshot), not a separate subscribe. Since
  // `hasDrained ⇒ hasBoard ⇒ openReadiness`, the readiness stream is always open
  // when this is set.
  //
  // fn-1150: DERIVE the opt-in from the parsed condition set (ADR 0011) — the
  // union of `drained --fail-on-stuck` and every dispatch-derived needs-human
  // signal (the dispatch trio + the umbrella, per `needsHumanSignalNeedsFold`).
  // dead-letter / block-escalation / parked-question ride always-folded snapshot
  // members and must NOT open the fold. Deriving it here (never a hand-maintained
  // flag) makes a narrow mis-wire structurally impossible: a signal that needs the
  // fold cannot be armed without opening it.
  const openDispatchFailures =
    (hasDrained && args.failOnStuck) ||
    args.segments.some(
      (s) =>
        isNeedsHumanCondition(s.condition) &&
        needsHumanSignalNeedsFold(s.condition),
    );
  // `monitor-running` reads jobs rows but is own-session-scoped — it needs
  // NO git root (unlike `agents-idle`, which scopes by cwd containment).
  const needsRoot = hasGitClean || hasAgentsIdle;
  // Both `agents-idle` and `monitor-running` read the jobs collection.
  const needsJobs = hasAgentsIdle || hasMonitorRunning;
  // Open the readiness stream when any plan OR board segment is present; it
  // already folds git + jobs so those families ride it. Otherwise open a
  // dedicated git / jobs collection stream per family used.
  const openReadiness = hasPlan || hasBoard;
  const openGitCollection = hasGitClean && !openReadiness;
  const openJobsCollection = needsJobs && !openReadiness;
  // `server-up` gets its OWN minimal readiness subscribe (always
  // give-up-exempt) — NOT bolted onto `openReadiness`, which would drag in
  // the plan re-query machinery.
  const openServerUp = hasServerUp;

  // Build the latched slots in segment order (the line render walks them).
  const slots: SlotState[] = args.segments.map((seg): SlotState => {
    if (
      seg.condition === "complete" ||
      seg.condition === "unblocked" ||
      seg.condition === "started"
    ) {
      return {
        kind: "plan",
        target: seg.target,
        met: false,
        lastEval: null,
        presentThisConnection: false,
        everSeen: false,
        lastVerdictPhrase: null,
        completeStability: initCompleteStability(),
      };
    }
    if (seg.condition === "monitor-running") {
      return {
        kind: "monitor-running",
        selector: seg.selector,
        raw: seg.raw,
        met: false,
        lastEval: null,
        lastVerdictPhrase: null,
      };
    }
    if (isNeedsHumanCondition(seg.condition)) {
      // fn-1150 needs-human board slot: level-triggered, so it uses only `since`
      // (the anti-spin anchor) and leaves the baseline fields unused. A dedicated
      // branch (not folded into the literal board `||` chain below) so the
      // discriminated-union narrowing on `seg.condition` stays clean.
      return {
        kind: seg.condition,
        ...("since" in seg && seg.since !== undefined
          ? { since: seg.since }
          : {}),
        met: false,
        lastEval: null,
        lastVerdictPhrase: null,
        baselineCaptured: false,
        baselineEpicIds: [],
        baselineSignature: null,
      };
    }
    if (
      seg.condition === "drained" ||
      seg.condition === "changed" ||
      seg.condition === "epic-added" ||
      seg.condition === "epic-removed" ||
      seg.condition === "landed"
    ) {
      return {
        kind: seg.condition,
        ...("target" in seg && seg.target !== undefined
          ? { target: seg.target }
          : {}),
        ...("since" in seg && seg.since !== undefined
          ? { since: seg.since }
          : {}),
        met: false,
        lastEval: null,
        lastVerdictPhrase: null,
        baselineCaptured: false,
        baselineEpicIds: [],
        baselineSignature: null,
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
  // fn-897 B1: latest `git_seed_required` off the boot-status header. While the
  // daemon is booting, the git surface reads EMPTY only because the boot-seed
  // hasn't run — so `git-clean` must hold `waiting` (UNKNOWN, never "clean")
  // until it seeds. Defaults `false` (steady state / a server that stamps no
  // header → treat as seeded).
  let latestGitSeedRequired = false;
  // fn-1015: latest boot-status `catching_up` (latched off the same header). The
  // `drained` predicate refuses to report drained while the reducer is still
  // draining toward head. Defaults `false` (steady state / a server stamping no
  // header → treat as caught up).
  let latestCatchingUp = false;
  // fn-1015 / ADR 0011: latest `dispatch_failures.reason` strings, latched off
  // the readiness snapshot's `dispatchFailures` member (the stream opts into
  // `includeDispatchFailures` only for `drained --fail-on-stuck`). Null until
  // first-painted; the drained jam check reads it.
  let latestDispatchFailureReasons: readonly string[] | null = null;
  // Latest readiness snapshot (null until first paint); plan + (when
  // riding readiness) git/jobs read off it.
  let latestReadiness: ReadinessClientSnapshot | null = null;

  // Aggregate first-paint gate: hold `armed` + the first eval until EVERY
  // opened subscription has first-painted. `painted` flags flip on the
  // first `result` per stream; reset on that stream's `disconnected`.
  const paintGate = {
    readiness: !openReadiness,
    git: !openGitCollection,
    jobs: !openJobsCollection,
    // `server-up` (fn-750.2): its own paint flag, off until the dedicated
    // give-up-exempt readiness stream first-paints. Folded into the same
    // `allPainted()` AND so `server-up`'s single slot only `met`s once the
    // daemon is actually serving.
    serverUp: !openServerUp,
  };
  const allPainted = (): boolean =>
    paintGate.readiness &&
    paintGate.git &&
    paintGate.jobs &&
    paintGate.serverUp;

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
    serverUp: true,
  };

  let readinessHandle: ReadinessClientHandle | null = null;
  let gitHandle: ReadinessClientHandle | null = null;
  let jobsHandle: ReadinessClientHandle | null = null;
  let deadlineHandle: unknown = null;
  // fn-1210: the `complete`-dwell re-evaluation timer. The subscribe stream is
  // change-driven and freezes on a DB-quiet board, so a completion that reads as
  // the final board activity delivers no second frame — this timer re-runs
  // `evaluate` after the dwell so the elapsed-time confirmation fires anyway.
  // Armed on demand (`ensureDwellTimer`) whenever a `complete` slot is holding an
  // unconfirmed completion; self-reschedules until it confirms or the world moves.
  let dwellHandle: unknown = null;
  // Task 2: the periodic stderr-only heartbeat timer, self-rescheduling like
  // `dwellHandle`. Armed once arming completes (`ensureHeartbeatTimer`,
  // regardless of `--no-armed-line` — that flag governs only the initial
  // armed line); cleared in `cleanupSubscriptions` so it never leaks past a
  // terminal or SIGTERM.
  let heartbeatHandle: unknown = null;
  let unregisterSignals: (() => void) | null = null;

  // Wall-clock accessor for the `complete`-dwell confirmation. Injected under
  // test (`deps.now`) so the fake-timer harness drives the dwell deterministically;
  // production falls back to `Date.now`.
  const nowMs = (): number => deps.now?.() ?? Date.now();

  const cleanupSubscriptions = (): void => {
    if (deadlineHandle !== null) {
      deps.clearTimer(deadlineHandle);
      deadlineHandle = null;
    }
    if (dwellHandle !== null) {
      deps.clearTimer(dwellHandle);
      dwellHandle = null;
    }
    if (heartbeatHandle !== null) {
      deps.clearTimer(heartbeatHandle);
      heartbeatHandle = null;
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
   * `exit` so a piped fd actually drains. `probe` (task 3) is the
   * `--probe`-only explanation envelope — its own event kind, never
   * conflated with the byte-stable `met`/`failed` terminal contract.
   */
  const emitTerminal = (
    event: "met" | "failed" | "probe",
    code: number,
    fields: Record<string, string | string[]>,
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
  // plan slot it's `<condition> <id>`; for git/jobs it's the bare
  // condition tag.
  const slotLabel = (slot: SlotState): string => {
    if (slot.kind === "plan") {
      return `${slot.target.condition} ${slot.target.id}`;
    }
    if (slot.kind === "monitor-running") {
      return `monitor-running ${slot.raw}`;
    }
    if (
      (slot.kind === "epic-added" ||
        slot.kind === "epic-removed" ||
        slot.kind === "landed") &&
      slot.target !== undefined
    ) {
      return `${slot.kind} ${slot.target}`;
    }
    return slot.kind;
  };

  const emitArmed = (initials: AwaitState[]): void => {
    if (state.armed) {
      return;
    }
    // Latch the armed state on the first arming tick regardless of
    // `--no-armed-line` — the flag suppresses only the printed line below,
    // never the lifecycle flip. This keeps the JSON envelope's `armed`
    // truthful and lets the require-transition edge guard, the reconnect-blip
    // swallow, and progress logging engage exactly as they do without the flag.
    state.armed = true;
    state.result.armed = true;
    if (args.noArmedLine) {
      return;
    }
    let fields: Record<string, string>;
    if (single && slots[0]?.kind === "plan") {
      // Byte-identical single-plan line shape (external contract).
      const t = slots[0].target;
      const initial = initials[0] ?? { kind: "waiting" as const };
      fields = {
        target: t.id,
        kind: t.kind,
        condition: t.condition,
        state: initial.detail ?? initial.kind,
      };
    } else if (single && slots[0]?.kind === "monitor-running") {
      // Single monitor-running condition: bare condition + selector + state.
      const initial = initials[0] ?? { kind: "waiting" as const };
      fields = {
        condition: "monitor-running",
        selector: slots[0].raw,
        state: initial.detail ?? initial.kind,
      };
    } else if (single && slots[0] !== undefined && isBoardSlot(slots[0])) {
      // fn-1015/fn-1016/fn-1150 single board condition: bare condition (+ target)
      // + state. A needs-human slot additionally surfaces the current signature so
      // a supervisor can capture it to re-arm with `since:<signature>`.
      const slot = slots[0];
      const initial = initials[0] ?? { kind: "waiting" as const };
      fields = {
        condition: slot.kind,
        ...(slot.target !== undefined ? { target: slot.target } : {}),
        state: initial.detail ?? initial.kind,
        ...(initial.signature !== undefined
          ? { signature: initial.signature }
          : {}),
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

  // Emit the aggregate terminal `met` (single line; for a single plan
  // slot the field shape is byte-identical to pre-fn-713).
  const emitAggregateMet = (): void => {
    if (single && slots[0]?.kind === "plan") {
      const slot = slots[0];
      const t = slot.target;
      const fields: Record<string, string | string[]> = {
        target: t.id,
        kind: t.kind,
        condition: t.condition,
        detail: slot.lastEval?.detail ?? "",
      };
      emitTerminal("met", 0, fields);
      return;
    }
    if (single && slots[0]?.kind === "monitor-running") {
      emitTerminal("met", 0, {
        condition: "monitor-running",
        selector: slots[0].raw,
        detail: slots[0].lastEval?.detail ?? "",
      });
      return;
    }
    if (single && slots[0] !== undefined && isBoardSlot(slots[0])) {
      // fn-1150: every needs-human met envelope carries the current signature (the
      // re-arm anchor); the other board conditions leave it undefined.
      const slot = slots[0];
      emitTerminal("met", 0, {
        condition: slot.kind,
        ...(slot.target !== undefined ? { target: slot.target } : {}),
        detail: slot.lastEval?.detail ?? "",
        ...(slot.lastEval?.signature !== undefined
          ? { signature: slot.lastEval.signature }
          : {}),
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

  // A plan slot reached a short-circuit terminal failure (not-found /
  // deleted / stuck). For a single segment the line is byte-identical;
  // for an aggregate it names which condition failed.
  const emitPlanFailure = (
    slot: PlanSlotState,
    reason: "not-found" | "deleted" | "stuck" | "ambiguous",
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
    // Task 2: `stuck` is an operator-jam refusal, never self-clearing from
    // the wait's own perspective — not retryable by re-arming the same await.
    if (reason === "stuck") {
      base.retryable = "false";
    }
    emitTerminal("failed", code, base);
  };

  // Refuse-upfront for `monitor-running` (fn-718, T3): at arm time, if the
  // selector matches NO running monitor in the caller's own session, the
  // predicate would already read `met` — but firing `met` immediately on a
  // never-started selector is premature-unblock. We instead refuse loudly
  // (`reason=no-match` exit 1) — mirrors the plan `not-found` refusal
  // and the skill's off-board pre-check. Caveat: arm this in a turn AFTER a
  // Stop has snapshotted the monitor; arming in the SAME turn you launch it
  // races the snapshot and trips this refusal.
  const emitMonitorNoMatch = (slot: MonitorSlotState): void => {
    const base: Record<string, string> = {
      reason: "no-match",
      condition: "monitor-running",
      selector: slot.raw,
    };
    if (!single) {
      base.from = slotLabel(slot);
    }
    emitTerminal("failed", 1, base);
  };

  // fn-1015: a board slot reached a terminal failure (today only `drained
  // --fail-on-stuck` → `stuck` exit 5 on an operator jam). Single-segment names
  // the bare condition; an aggregate additionally carries `from`.
  const emitBoardFailure = (
    slot: BoardSlotState,
    reason: "stuck",
    code: number,
    detail: string | undefined,
  ): void => {
    const base: Record<string, string> = { reason, condition: slot.kind };
    if (slot.target !== undefined) {
      base.target = slot.target;
    }
    if (detail !== undefined && detail.length > 0) {
      base.detail = detail;
    }
    if (!single) {
      base.from = slotLabel(slot);
    }
    // Task 2: mirrors `emitPlanFailure`'s stuck classification.
    if (reason === "stuck") {
      base.retryable = "false";
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
  //
  // fn-775: returns a TRI-STATE. `hit`/`miss` are the confirmed
  // present/absent verdicts; `indeterminate` means the re-query could not
  // confirm either — a `max_connections` cap reject kept it unpainted past
  // `REQUERY_GIVE_UP_MS` (the give-up driver fires `onFatal({code:
  // "unreachable"})`). An indeterminate verdict must NEVER commit `deleted` —
  // the caller stays armed and defers to the next steady-poll re-trigger.
  // A genuine malformed-query fatal still resolves `miss` (the prior `false`
  // behavior — a query-shape error means the row really isn't fetchable here).
  const reQueryHit = async (epicIdToFetch: string): Promise<ReQueryOutcome> => {
    return await new Promise<ReQueryOutcome>((resolve) => {
      let resolved = false;
      let oneShotHandle: ReadinessClientHandle | null = null;
      const finish = (outcome: ReQueryOutcome): void => {
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
        resolve(outcome);
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
            finish(rows.length > 0 && rows[0] !== undefined ? "hit" : "miss");
          },
          // fn-775: an `unreachable` fatal is the cap-reject give-up — resolve
          // indeterminate (never `deleted`). Any other fatal is a genuine
          // query-shape terminal → `miss` (the prior behavior).
          onFatal: (err) =>
            finish(err.code === "unreachable" ? "indeterminate" : "miss"),
          giveUpPolicy: { deadlineMs: REQUERY_GIVE_UP_MS },
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.connect === undefined ? {} : { connect: deps.connect }),
        });
      } catch {
        finish("miss");
      }
    });
  };

  /**
   * For task targets the re-query alone isn't enough — the parent epic
   * may survive while the task element was dropped. This helper does
   * the same one-shot re-query and also walks the returned epic's
   * `tasks[]` array.
   */
  const reQueryHitTask = async (taskId: string): Promise<ReQueryOutcome> => {
    const dot = taskId.lastIndexOf(".");
    if (dot <= 0) {
      return "miss";
    }
    const epicId = taskId.slice(0, dot);
    return await new Promise<ReQueryOutcome>((resolve) => {
      let resolved = false;
      let oneShotHandle: ReadinessClientHandle | null = null;
      const finish = (outcome: ReQueryOutcome): void => {
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
        resolve(outcome);
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
              finish("miss");
              return;
            }
            const tasksRaw = (row as { tasks?: unknown }).tasks;
            if (!Array.isArray(tasksRaw)) {
              finish("miss");
              return;
            }
            for (const t of tasksRaw) {
              if (
                t !== null &&
                typeof t === "object" &&
                (t as { task_id?: unknown }).task_id === taskId
              ) {
                finish("hit");
                return;
              }
            }
            finish("miss");
          },
          // fn-775: cap-reject give-up → indeterminate (never `deleted`); any
          // other fatal → `miss` (prior behavior). See `reQueryHit`.
          onFatal: (err) =>
            finish(err.code === "unreachable" ? "indeterminate" : "miss"),
          giveUpPolicy: { deadlineMs: REQUERY_GIVE_UP_MS },
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.connect === undefined ? {} : { connect: deps.connect }),
        });
      } catch {
        finish("miss");
      }
    });
  };

  // ---- per-slot evaluation -------------------------------------------

  /**
   * SYNCHRONOUS first pass over one plan slot off the latest readiness
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
  const evalPlanSlotSync = (
    slot: PlanSlotState,
    snap: ReadinessClientSnapshot,
    isReconnectBaseline: boolean,
  ): { result: AwaitState; blip: boolean; needsReQuery: boolean } => {
    const inputs: AwaitInputs = {
      epics: snap.epics as readonly Epic[],
      snapshot: snap.readiness,
      priorPresence: slot.everSeen,
      // fn-941: the escalated-but-paused softening — an escalated `runtime-blocked`
      // task held only by a paused autopilot reports `waiting`, not `stuck`.
      escalatedTaskIds: escalatedTaskIdsOf(snap),
      autopilotPaused: snap.autopilotPaused,
    };
    const evalState = evaluateAwaitCondition(inputs, slot.target);

    const presentNow =
      evalState.kind !== "not-found" && evalState.kind !== "deleted";
    if (presentNow) {
      slot.presentThisConnection = true;
      slot.everSeen = true;
    }

    // Dwell confirmation for `complete`: the done-AND-idle `completed` verdict
    // can flap back to `running` when a done task's owning worker re-activates
    // during close-out reconciliation. `met` fires on the FIRST completed
    // observation, so withhold it until the completion HOLDS `completed` at a
    // stable target-row version for `COMPLETE_DWELL_MS`. Counting FRAMES would
    // hang on a quiet board (the change-driven stream delivers no second frame),
    // so the elapsed-dwell basis lets the bounded re-evaluation timer confirm a
    // quiet completion with no further frame while a version-bumping flap (even a
    // coalesced one) restarts the dwell. Only the PRESENT branch reaches `met`
    // here (the re-query `met` is Pass 2 and already terminal), so a
    // completed-but-unconfirmed observation downgrades to `waiting`; every other
    // verdict resets the dwell and passes through. Inert for `unblocked`/`started`.
    let result = evalState;
    if (slot.target.condition === "complete") {
      const { next, confirmed } = advanceCompleteStability(
        slot.completeStability,
        evalState.kind === "met",
        completeWatermark(inputs.epics, slot.target),
        nowMs(),
      );
      slot.completeStability = next;
      if (evalState.kind === "met" && !confirmed) {
        result = {
          kind: "waiting",
          detail: "completion holding (dwell not yet elapsed)",
        };
      }
    }

    // Reconnect-blip gate: a post-reconnect baseline absence that would
    // commit `deleted` is swallowed (only AFTER we've armed).
    if (isReconnectBaseline && state.armed && evalState.kind === "deleted") {
      return { result, blip: true, needsReQuery: false };
    }

    const needsReQuery =
      evalState.kind === "deleted" ||
      (slot.target.condition === "complete" &&
        slot.target.kind === "epic" &&
        slot.everSeen &&
        !inputs.epics.some((e) => e.epic_id === slot.target.id));
    return { result, blip: false, needsReQuery };
  };

  /**
   * Kick off the scope-exempt re-query promise for one slot WITHOUT an
   * extra async wrapper — `evaluate` awaits this directly so the microtask
   * resume chain stays as shallow as the pre-fn-713 single-target path
   * (the runner test harness flushes a fixed number of microtasks between
   * delivering the re-query result and asserting). Returns the raw hit
   * promise; the caller folds it into `evaluateAwaitCondition`.
   */
  const reQueryForSlot = (slot: PlanSlotState): Promise<ReQueryOutcome> =>
    slot.target.kind === "task"
      ? reQueryHitTask(slot.target.id)
      : reQueryHit(slot.target.id);

  // Build the `changedSignature` input from a readiness snapshot — the coarse
  // orient surface (epics + verdicts + autopilot), git/subagent/job churn
  // excluded so `changed` fires on a real board move.
  const boardSignatureInputOf = (
    snap: ReadinessClientSnapshot,
  ): BoardSignatureInput => ({
    epics: snap.epics.map((e) => ({ epic_id: e.epic_id, status: e.status })),
    perTask: snap.readiness.perTask,
    perCloseRow: snap.readiness.perCloseRow,
    perEpic: snap.readiness.perEpic,
    autopilot: {
      mode: snap.autopilotMode,
      paused: snap.autopilotPaused,
      worktreeMode: snap.worktreeMode,
      maxConcurrentJobs: snap.maxConcurrentJobs,
      maxConcurrentPerRootStored: snap.maxConcurrentPerRootStored,
    },
  });

  /**
   * Evaluate one board slot (fn-1015) off the latest readiness snapshot plus
   * the latched `catching_up` / `dispatch_failures`. Captures the first-paint
   * baseline ONCE for the edge-triggered families (never reset on reconnect, so
   * a re-paint of an unchanged board is a null-diff). `drained` is
   * level-triggered and ignores the baseline. Pure wrt its inputs — all I/O is
   * the caller's.
   */
  const evalBoardSlot = (
    slot: BoardSlotState,
    snap: ReadinessClientSnapshot,
  ): AwaitState => {
    if (slot.kind === "landed") {
      // fn-1016: level-triggered membership read off the merge-landed set — no
      // baseline (a positive milestone, like `drained`). The worktree ON/OFF
      // degradation is already baked into `landedEpicIds` (task-1).
      return landedState(slot.target ?? "", snap.landedEpicIds);
    }
    if (isNeedsHumanKind(slot.kind)) {
      // fn-1150: level-triggered presence off the ONE shared needs-human projector
      // (ADR 0011) — no first-paint baseline (the `since:<signature>` anchor, if
      // any, is the only anti-spin gate). `dispatchFoldOpened` is derived from the
      // snapshot member's presence: when the opt-in was armed the gated fold
      // paints `dispatchFailures` (possibly empty); when a dispatch-derived signal
      // reaches here with it absent, `needsHumanState` throws (a wiring bug, never
      // a silent forever-wait). dead-letter / block-escalation / parked-question
      // ride the always-folded members below.
      const projection = projectNeedsHuman({
        dispatchFailures: snap.dispatchFailures ?? [],
        deadLetters: snap.deadLetters.length,
        blockEscalations: snap.blockEscalations.length,
        parkedQuestionEpicIds: snap.epics
          .filter((e) => (e.question ?? null) !== null)
          .map((e) => e.epic_id),
        epicIds: snap.epics.map((e) => e.epic_id),
      });
      return needsHumanState(slot.kind, projection, {
        dispatchFoldOpened: snap.dispatchFailures !== undefined,
        ...(slot.since !== undefined ? { since: slot.since } : {}),
      });
    }
    if (!slot.baselineCaptured) {
      slot.baselineEpicIds = snap.epics.map((e) => e.epic_id);
      slot.baselineSignature =
        slot.since ?? changedSignature(boardSignatureInputOf(snap));
      slot.baselineCaptured = true;
    }
    if (slot.kind === "drained") {
      // Project every working job into a scoped holder input — the pure
      // predicate applies the scope's provenance + self-exclusion filter.
      const runningJobs = projectDrainedRunningJobs(snap.jobs.values());
      const pendingDispatches: DrainedHolder[] = snap.pendingDispatches.map(
        (p) => ({
          kind: "pending",
          id: `${p.verb}::${p.id}`,
          label: `${p.verb}::${p.id}`,
        }),
      );
      return drainedState({
        scope: args.scope,
        perTask: snap.readiness.perTask,
        perCloseRow: snap.readiness.perCloseRow,
        openEpicCount: snap.epics.length,
        pendingDispatches,
        runningJobs,
        ownSessionId: deps.ownSessionId,
        catchingUp: latestCatchingUp,
        ...(latestDispatchFailureReasons === null
          ? {}
          : { dispatchFailureReasons: latestDispatchFailureReasons }),
        failOnStuck: args.failOnStuck,
      });
    }
    const currentEpicIds = snap.epics.map((e) => e.epic_id);
    if (slot.kind === "epic-added") {
      return epicAddedMet(slot.baselineEpicIds, currentEpicIds, slot.target)
        ? {
            kind: "met",
            detail: slot.target ? `epic ${slot.target} added` : "epic added",
          }
        : { kind: "waiting", detail: "no qualifying epic added yet" };
    }
    if (slot.kind === "epic-removed") {
      const target = slot.target ?? "";
      return epicRemovedMet(slot.baselineEpicIds, currentEpicIds, target)
        ? { kind: "met", detail: `epic ${target} removed` }
        : { kind: "waiting", detail: `waiting for epic ${target} to leave` };
    }
    // changed
    const sig = changedSignature(boardSignatureInputOf(snap));
    return sig !== slot.baselineSignature
      ? { kind: "met", detail: "board changed" }
      : { kind: "waiting", detail: "board unchanged" };
  };

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
      const label =
        slot.kind === "plan"
          ? slot.target.id
          : slot.kind === "monitor-running"
            ? `monitor-running ${slot.raw}`
            : slot.kind;
      deps.writeStderr(
        `[keeper-await] progress target=${label} state=${sanitizeValue(phrase)}${suffix}\n`,
      );
      slot.lastVerdictPhrase = phrase;
    }
  };

  /**
   * Max holder/slot entries a heartbeat line names before it truncates to a
   * literal `+N more` tail (task 2). Holder labels are attacker-influenced (a
   * session/monitor title), so the list is bounded regardless of board size.
   */
  const MAX_HEARTBEAT_ENTRIES = 5;

  /** Bound a display list to `MAX_HEARTBEAT_ENTRIES`, appending a `+N more`
   *  tail once it overruns. `eventLine` sanitizes each element (CR/LF strip)
   *  when it renders the line — this only bounds cardinality. */
  const boundedList = (items: readonly string[]): string[] => {
    if (items.length <= MAX_HEARTBEAT_ENTRIES) {
      return [...items];
    }
    return [
      ...items.slice(0, MAX_HEARTBEAT_ENTRIES),
      `+${items.length - MAX_HEARTBEAT_ENTRIES} more`,
    ];
  };

  /**
   * Periodic stderr-only progress line (task 2) — `logProgress` generalized
   * from a verdict-change throttle to a wall-clock cadence, so a long silent
   * wait stays legible. NEVER touches stdout (the byte-stable terminal
   * contract) and never re-runs `evaluate()` — it only renders the slots'
   * current latched state, so it cannot double-fire the eval loop.
   *
   * While any stream the active slots depend on hasn't yet painted a FRESH
   * snapshot since its last reconnect, names the reconnecting state instead
   * of stale pre-drop holders (reuses `reconnectStable`/`paintGate` — the
   * same "has this stream painted since its last drop" signal the blip gate
   * already maintains, rather than tracking connection state twice). Once a
   * post-reconnect snapshot lands, `evaluate()` flips it back before this
   * next fires. Otherwise names each not-yet-met slot's condition/state,
   * plus — for a `drained`-family slot — its structured {@link DrainedHolder}
   * list (task 1), size-bounded via {@link boundedList}.
   */
  const emitHeartbeat = (): void => {
    if (state.terminating) {
      return;
    }
    const reconnecting =
      (openReadiness && !reconnectStable.readiness) ||
      (openGitCollection && !reconnectStable.git) ||
      (openJobsCollection && !reconnectStable.jobs) ||
      (openServerUp && !paintGate.serverUp);
    if (reconnecting) {
      deps.writeStderr(
        eventLine(args.json, "heartbeat", {
          state: "reconnecting",
          detail: "reconnecting to keeperd — holder list stale, withheld",
        }),
      );
      return;
    }
    const waiting = slots.filter((s) => !s.met);
    if (waiting.length === 0) {
      // Every slot already latched met — a met/failed terminal is imminent
      // (or already fired and cleared this timer); nothing to name.
      return;
    }
    const fields: Record<string, string | string[]> = {
      state: "waiting",
      waiting: boundedList(
        waiting.map((s) => {
          const ev = s.lastEval;
          const phrase = ev?.detail ?? ev?.kind ?? "waiting";
          return `${slotLabel(s)}: ${sanitizeValue(phrase)}`;
        }),
      ),
    };
    const holders = waiting.flatMap((s) => s.lastEval?.holders ?? []);
    if (holders.length > 0) {
      fields.holders = boundedList(
        holders.map((h) => `${h.label} (${h.kind})`),
      );
    }
    deps.writeStderr(eventLine(args.json, "heartbeat", fields));
  };

  /**
   * Arm the periodic heartbeat if `--heartbeat` isn't `off` and it isn't
   * already pending — idempotent-while-pending like `ensureDwellTimer`, so
   * repeated arm-detection calls under `--no-armed-line` (which never flips
   * `state.armed`, see {@link emitArmed}) can't stack timers. Self-
   * reschedules after every fire until `cleanupSubscriptions` clears it on
   * terminate, so it never leaks past a met/failed/SIGTERM exit.
   */
  const ensureHeartbeatTimer = (): void => {
    if (
      args.heartbeatMs === null ||
      heartbeatHandle !== null ||
      state.terminating
    ) {
      return;
    }
    heartbeatHandle = deps.setTimer(() => {
      heartbeatHandle = null;
      emitHeartbeat();
      ensureHeartbeatTimer();
    }, args.heartbeatMs);
  };

  /**
   * Shared re-evaluation pass — the ONE place the AND gate is computed.
   * Walks every slot, evaluates each off the latest rows it cares about,
   * latches `met`, short-circuits on any plan terminal failure, and
   * emits the aggregate `met` only when EVERY slot is simultaneously met.
   *
   * Held behind the aggregate first-paint gate (`allPainted()`): until
   * every opened subscription has first-painted we neither arm nor eval,
   * so a slow stream can't let the AND glitch-fire early.
   */
  // Is any `complete` slot holding an unconfirmed completion (completed at least
  // once, dwell not yet elapsed, not latched `met`)? Such a slot needs the
  // bounded re-evaluation timer because the change-driven stream may deliver no
  // further frame to re-check the dwell.
  const anyCompleteHolding = (): boolean =>
    slots.some(
      (s) =>
        s.kind === "plan" &&
        s.target.condition === "complete" &&
        !s.met &&
        s.completeStability.since !== null,
    );

  // Arm the `complete`-dwell re-evaluation timer if it isn't already pending. The
  // timer re-runs `evaluate` after the dwell; on a quiet board the re-run sees the
  // elapsed dwell and confirms with no second frame. Self-rescheduling: if the
  // dwell still hasn't elapsed at fire time (a version bump reset it), `evaluate`
  // re-arms it. Idempotent while pending so back-to-back frames don't stack timers.
  const ensureDwellTimer = (): void => {
    if (dwellHandle !== null || state.terminating) {
      return;
    }
    dwellHandle = deps.setTimer(() => {
      dwellHandle = null;
      void evaluate();
    }, COMPLETE_DWELL_MS);
  };

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
      if (slot.kind === "plan") {
        if (latestReadiness === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const { result, blip, needsReQuery } = evalPlanSlotSync(
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
        // fn-897 B1: pass the boot-status `git_seed_required` so an unseeded
        // surface holds `waiting` (UNKNOWN), never falsely reports "clean" off
        // the empty rows it produces during catch-up.
        const result = gitCleanState(
          deps.gitRoot,
          latestGitRows,
          latestGitSeedRequired,
        );
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "agents-idle") {
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
      } else if (slot.kind === "monitor-running") {
        // own-session-scoped; needs jobs rows + the caller's own session
        // id, NO git root.
        if (latestJobRows === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = monitorRunningState(
          deps.ownSessionId,
          slot.selector,
          latestJobRows,
        );
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "server-up") {
        // `server-up` (fn-750.2): no rows, no pure evaluator. `evaluate()`
        // only runs once `allPainted()` clears, which for server-up means
        // the daemon served its first snapshot — so reaching here IS the
        // condition. Latch `met` unconditionally.
        const result: AwaitState = { kind: "met", detail: "serving" };
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = true;
        evals[i] = result;
      } else if (isBoardSlot(slot)) {
        // fn-1015/fn-1016/fn-1150 board slots: all read off the readiness snapshot.
        // Hold `waiting` until it paints.
        if (latestReadiness === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = evalBoardSlot(slot, latestReadiness);
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      }
    }

    // First-paint baseline: arm OR emit a plan `not-found` terminal.
    // A `not-found` only arises on the synchronous (non-deferred) path —
    // the deferred path is a present-then-absent drop, which is
    // `deleted`/`met`, never `not-found`.
    let justArmed = false;
    if (!state.armed && state.result.terminalLine === null) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const ev = evals[i];
        if (slot?.kind === "plan" && ev?.kind === "not-found") {
          emitPlanFailure(slot, "not-found", 1, undefined);
          return;
        }
        // A bare `fn-N` target resolving to 2+ live epics is a terminal usage
        // refusal known at arm time (fn-1193) — exit 6 naming the candidates.
        if (slot?.kind === "plan" && ev?.kind === "ambiguous") {
          emitPlanFailure(slot, "ambiguous", 6, ev.detail);
          return;
        }
        // Refuse-upfront: a `monitor-running` slot that's already `met` at
        // arm time matched no running monitor in this session — refuse
        // loudly instead of an instant `met` (premature-unblock guard).
        if (slot?.kind === "monitor-running" && ev?.kind === "met") {
          emitMonitorNoMatch(slot);
          return;
        }
      }
      emitArmed(evals.map((e) => e ?? { kind: "waiting" }));
      justArmed = state.armed;
      // Arm the heartbeat once we've passed every synchronous refusal above.
      // `state.armed` latches here regardless of `--no-armed-line` (which
      // suppresses only the printed line), so this block runs once and the
      // timer is armed once.
      ensureHeartbeatTimer();
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
        if (slot === undefined || slot.kind !== "plan") {
          continue;
        }
        let outcome: ReQueryOutcome = "miss";
        try {
          outcome = await reQueryForSlot(slot);
        } catch {
          outcome = "miss";
        }
        if (state.terminating) {
          return;
        }
        // fn-775: INDETERMINATE — the re-query couldn't confirm deletion (a
        // `max_connections` cap reject exhausted its bounded retry). Do NOT
        // commit `deleted`: hold the slot at its prior verdict (met if already
        // latched, else waiting), stay armed, and let the next steady-poll
        // absent-transition re-trigger the re-query once the cap frees. A
        // verifier that can't check defers — it never converts "couldn't
        // check" into a terminal `deleted`.
        if (outcome === "indeterminate") {
          const held: AwaitState = slot.met
            ? { kind: "met" }
            : {
                kind: "waiting",
                detail: "re-query indeterminate (cap reject)",
              };
          slot.lastEval = held;
          logProgress(slot, held);
          evals[i] = held;
          continue;
        }
        const result = evaluateAwaitCondition(
          {
            epics: snap.epics as readonly Epic[],
            snapshot: snap.readiness,
            priorPresence: slot.everSeen,
            reQueryHit: outcome === "hit",
            escalatedTaskIds: escalatedTaskIdsOf(snap),
            autopilotPaused: snap.autopilotPaused,
          },
          slot.target,
        );
        slot.lastEval = result;
        logProgress(slot, result);
        slot.met = result.kind === "met";
        evals[i] = result;
      }
    }

    // Short-circuit on any plan terminal failure (deleted / stuck).
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (slot?.kind !== "plan" || ev === undefined || ev === null) {
        continue;
      }
      if (ev.kind === "deleted") {
        emitPlanFailure(slot, "deleted", 4, undefined);
        return;
      }
      if (ev.kind === "stuck" && args.failOnStuck) {
        emitPlanFailure(slot, "stuck", 5, ev.detail);
        return;
      }
      // A bare-id ambiguity that first arises mid-stream (a second same-number
      // epic appears) is terminal too — exit 6 naming the candidates (fn-1193).
      if (ev.kind === "ambiguous") {
        emitPlanFailure(slot, "ambiguous", 6, ev.detail);
        return;
      }
    }

    // fn-1015: short-circuit on a board slot's `stuck` (drained jam) under
    // `--fail-on-stuck` → exit 5, mirroring the plan stuck path.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (
        slot === undefined ||
        ev === undefined ||
        ev === null ||
        !(
          slot.kind === "drained" ||
          slot.kind === "changed" ||
          slot.kind === "epic-added" ||
          slot.kind === "epic-removed"
        )
      ) {
        continue;
      }
      if (ev.kind === "stuck" && args.failOnStuck) {
        emitBoardFailure(slot, "stuck", 5, ev.detail);
        return;
      }
    }

    // Aggregate met: every slot latched met.
    if (slots.every((s) => s.met)) {
      emitAggregateMet();
    }

    // A `complete` slot holding an unconfirmed completion needs the bounded
    // re-evaluation timer: the change-driven stream freezes on a DB-quiet board,
    // so without a self-scheduled re-check the dwell would never elapse and a
    // quiet completion would hang. `emitAggregateMet` sets `terminating` when it
    // fires, so this is a no-op once the aggregate is met.
    if (!state.terminating && anyCompleteHolding()) {
      ensureDwellTimer();
    }
  };

  /**
   * `--probe` (task 3) terminal envelope: one `probe` event naming every
   * slot's condition + state (`detail` if present, else the bare `kind`),
   * plus the flattened, size-bounded `holders` list any drained-family slot
   * carries. `result` is `holds` (exit 0) when every slot latched `met`,
   * else `does-not-hold` (exit {@link EXIT_PROBE_DOES_NOT_HOLD}) — the
   * caller already resolved the more specific not-found/ambiguous/no-match/
   * stuck codes before falling through here (see `evaluateProbe`).
   */
  const emitProbeResult = (evals: readonly (AwaitState | null)[]): void => {
    const holds = slots.every((s) => s.met);
    const states = slots.map((s, i) => {
      const ev = evals[i];
      const phrase = ev?.detail ?? ev?.kind ?? "waiting";
      return `${slotLabel(s)}: ${sanitizeValue(phrase)}`;
    });
    const holders = evals.flatMap((e) => e?.holders ?? []);
    const fields: Record<string, string | string[]> = {
      result: holds ? "holds" : "does-not-hold",
      states,
    };
    if (holders.length > 0) {
      fields.holders = boundedList(
        holders.map((h) => `${h.label} (${h.kind})`),
      );
    }
    emitTerminal("probe", holds ? 0 : EXIT_PROBE_DOES_NOT_HOLD, fields);
  };

  /**
   * `--probe` (task 3) one-shot evaluation, run in place of `evaluate()`
   * when `args.probe` is set. Mirrors `evaluate()`'s Pass-1 SYNCHRONOUS
   * per-slot evaluators exactly (same helper functions, same results) but
   * drops everything that only matters to a long-lived wait: no deferred
   * scope-exempt re-query (structurally unreachable on a first pass —
   * `deleted` requires `priorPresence`, which starts false, see
   * `absentBranch`), no reconnect-blip bookkeeping, no dwell/heartbeat
   * timers, no `armed` line. It reads exactly the FIRST painted snapshot
   * once and answers.
   *
   * Definitive refusals reuse the SAME codes the ordinary arm path already
   * establishes — not-found=1, ambiguous=6, monitor no-match=1, stuck under
   * `--fail-on-stuck`=5 — so a jam sticky surfaces distinctly rather than
   * reading as a generic does-not-hold (task 3 risk). Only once none of
   * those apply does it fall back to the new probe verdict.
   */
  const evaluateProbe = (): void => {
    if (state.terminating || !allPainted()) {
      return;
    }

    const evals: (AwaitState | null)[] = slots.map(() => null);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined) {
        continue;
      }
      if (slot.kind === "plan") {
        if (latestReadiness === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const { result } = evalPlanSlotSync(slot, latestReadiness, false);
        slot.lastEval = result;
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "git-clean") {
        if (latestGitRows === null || deps.gitRoot === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = gitCleanState(
          deps.gitRoot,
          latestGitRows,
          latestGitSeedRequired,
        );
        slot.lastEval = result;
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "agents-idle") {
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
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "monitor-running") {
        if (latestJobRows === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = monitorRunningState(
          deps.ownSessionId,
          slot.selector,
          latestJobRows,
        );
        slot.lastEval = result;
        slot.met = result.kind === "met";
        evals[i] = result;
      } else if (slot.kind === "server-up") {
        // Reaching here means `paintGate.serverUp` cleared — the daemon
        // already served its first snapshot, which IS the condition.
        const result: AwaitState = { kind: "met", detail: "serving" };
        slot.lastEval = result;
        slot.met = true;
        evals[i] = result;
      } else if (isBoardSlot(slot)) {
        if (latestReadiness === null) {
          evals[i] = { kind: "waiting" };
          continue;
        }
        const result = evalBoardSlot(slot, latestReadiness);
        slot.lastEval = result;
        slot.met = result.kind === "met";
        evals[i] = result;
      }
    }

    // Definitive arm-time-shaped refusals — same codes as the ordinary path.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (slot?.kind === "plan" && ev?.kind === "not-found") {
        emitPlanFailure(slot, "not-found", 1, undefined);
        return;
      }
      if (slot?.kind === "plan" && ev?.kind === "ambiguous") {
        emitPlanFailure(slot, "ambiguous", 6, ev.detail);
        return;
      }
      if (slot?.kind === "monitor-running" && ev?.kind === "met") {
        emitMonitorNoMatch(slot);
        return;
      }
    }

    // A jam sticky is distinct from a plain does-not-hold, mirroring the
    // ordinary `--fail-on-stuck` short-circuit (task 3 risk note).
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (slot?.kind === "plan" && ev?.kind === "stuck" && args.failOnStuck) {
        emitPlanFailure(slot, "stuck", 5, ev.detail);
        return;
      }
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const ev = evals[i];
      if (
        slot === undefined ||
        ev === undefined ||
        ev === null ||
        // Mirrors `evaluate()`'s board-stuck check: only `drained` actually
        // produces a `stuck` verdict (`drainedState`'s jam predicate) — the
        // other board kinds (`landed`, needs-human) never reach it, so the
        // set stays hand-enumerated rather than the broader `isBoardSlot`.
        slot.kind !== "drained"
      ) {
        continue;
      }
      if (ev.kind === "stuck" && args.failOnStuck) {
        emitBoardFailure(slot, "stuck", 5, ev.detail);
        return;
      }
    }

    emitProbeResult(evals);
  };

  // Which re-evaluation pass a fresh snapshot drives: the ordinary
  // long-lived `evaluate()`, or `--probe`'s one-shot `evaluateProbe()`.
  const evaluateActive = args.probe ? evaluateProbe : evaluate;

  // ---- stream callbacks ----------------------------------------------

  const onReadinessSnapshot = (snap: ReadinessClientSnapshot): void => {
    latestReadiness = snap;
    paintGate.readiness = true;
    // When riding readiness for git/jobs (a plan-bearing combo), pull
    // the raw rows off the snapshot rather than a separate subscribe.
    if (hasGitClean) {
      latestGitRows = snap.gitStatus;
    }
    if (needsJobs) {
      latestJobRows = Array.from(snap.jobs.values());
    }
    // ADR 0011: the `drained --fail-on-stuck` jam check reads the sticky
    // `dispatch_failures` reasons off the SAME snapshot — the readiness stream
    // opts into `includeDispatchFailures` (below), so the rows ride first-paint
    // (the readiness gate holds until they paint) instead of a bespoke collection
    // stream. `reason` rides through the fold intact.
    if (openDispatchFailures) {
      latestDispatchFailureReasons = (snap.dispatchFailures ?? []).map((r) =>
        typeof r.reason === "string" ? r.reason : "",
      );
    }
    void evaluateActive();
  };

  const onGitRows = (rows: Record<string, unknown>[]): void => {
    latestGitRows = rows as unknown as GitStatus[];
    paintGate.git = true;
    void evaluateActive();
  };

  // fn-897 B1: latch `git_seed_required` off the boot-status header (carried on
  // every served frame during catch-up). Threaded into BOTH the readiness and
  // dedicated-git subscribes so `git-clean` never reports "clean" off an unseeded
  // surface, regardless of which stream feeds the git rows.
  // fn-1015: also latch `catching_up` off the same header so the `drained`
  // predicate never reports drained mid-catch-up.
  const onBootStatus = (boot: {
    git_seed_required: boolean;
    catching_up: boolean;
  }): void => {
    latestGitSeedRequired = boot.git_seed_required;
    latestCatchingUp = boot.catching_up;
  };

  const onJobRows = (rows: Record<string, unknown>[]): void => {
    latestJobRows = rows as unknown as Job[];
    paintGate.jobs = true;
    void evaluateActive();
  };

  // `server-up` (fn-750.2): first-paint IS the signal. We deliberately read
  // NO rows off the snapshot — the daemon serving its first composed
  // readiness frame is the whole condition. Flip the paint flag and let
  // `evaluate()`/`evaluateProbe()` latch the slot `met`.
  const onServerUpSnapshot = (_snap: ReadinessClientSnapshot): void => {
    paintGate.serverUp = true;
    void evaluateActive();
  };

  const onLifecycle =
    (stream: "readiness" | "git" | "jobs" | "serverUp") =>
    (event: string): void => {
      if (event === "disconnected") {
        reconnectStable[stream] = false;
        // `server-up` (fn-750.2): a disconnect re-closes the paint gate so
        // a reconnect-forever stream re-fires `met` only when the daemon is
        // serving AGAIN. Mirrors the readiness/git/jobs gate behavior.
        if (stream === "serverUp") {
          paintGate.serverUp = false;
        }
        if (stream === "readiness") {
          for (const slot of slots) {
            if (slot.kind === "plan") {
              slot.presentThisConnection = false;
            }
          }
        }
      }
    };

  /**
   * Task 2: "what held this wait at the deadline" — persisted per slot via
   * `slot.lastEval` (every eval branch above sets it, met or waiting alike),
   * so a timeout/unreachable terminal can report the last known state even
   * though neither is driven by a fresh eval of its own. Single-segment:
   * that slot's own detail. Aggregate: the first not-yet-met slot's labeled
   * detail (mirrors the `from=` single-holder convention elsewhere in this
   * file). `undefined` when nothing has painted yet (e.g. `unreachable`
   * firing before any snapshot ever landed) — the caller omits the field
   * rather than emit an empty one.
   */
  const lastWaitingDetail = (): string | undefined => {
    if (single) {
      const detail = slots[0]?.lastEval?.detail;
      return detail !== undefined && detail.length > 0 ? detail : undefined;
    }
    for (const slot of slots) {
      if (slot.met) {
        continue;
      }
      const detail = slot.lastEval?.detail;
      if (detail !== undefined && detail.length > 0) {
        return `${slotLabel(slot)}: ${detail}`;
      }
    }
    return undefined;
  };

  // Custom onFatal — the helper's default `process.exit(1)` would
  // bypass the terminal-line protocol. Route to a proper terminal line.
  // fn-750.2: the give-up driver fires `onFatal({ code: "unreachable" })`
  // when keeperd stays unpainted past the deadline. Render that as a
  // distinct `reason=unreachable` terminal (NOT `reason=connect`, which is
  // a query-shape rejection) carrying retry `advice`. Both routes share the
  // `emitTerminal` `terminating` latch, so this dedups across the up-to-three
  // give-up-eligible handles and preempts the reconnect-blip / `deleted`
  // swallow (whichever fires first wins, the rest no-op).
  const onFatal = (err: FatalError): void => {
    if (err.code === "unreachable") {
      const detail = lastWaitingDetail();
      emitTerminal("failed", 1, {
        reason: "unreachable",
        advice: "wait with 'keeper await server-up' then re-arm this command",
        message: err.message,
        // Task 2: unreachable is a give-up-deadline artifact of the daemon
        // link, not of the condition itself — retrying the same await (once
        // the daemon is back) is exactly the advice above.
        retryable: "true",
        ...(detail !== undefined ? { detail } : {}),
      });
      return;
    }
    emitTerminal("failed", 1, {
      reason: "connect",
      code: err.code,
      message: err.message,
    });
  };

  // Shared slot-identity skeleton for the two caller-terminated deadline
  // paths (own-`--timeout` and external signal). Single-plan is the
  // byte-identical external contract; otherwise a generalized shape. Each
  // caller appends its own `retryable`/`signal` tail + trailing `detail`
  // AFTER this skeleton, so the frozen timeout wire order
  // (reason,target,kind,condition,retryable,detail) is preserved exactly.
  const deadlineIdentityFields = (
    reason: "timeout" | "signal",
  ): Record<string, string> => {
    if (single && slots[0]?.kind === "plan") {
      const t = slots[0].target;
      return { reason, target: t.id, kind: t.kind, condition: t.condition };
    }
    return {
      reason,
      conditions: slots.map(slotLabel).join(" and "),
    };
  };

  const timeoutFields = (): Record<string, string> => {
    const detail = lastWaitingDetail();
    // Task 2: a `--timeout` deadline is the CALLER's own budget running out,
    // not a terminal verdict on the condition — re-arming the same await is
    // exactly what a caller does next, hence `retryable: "true"`.
    return {
      ...deadlineIdentityFields("timeout"),
      retryable: "true",
      ...(detail !== undefined ? { detail } : {}),
    };
  };

  // An external SIGTERM/SIGINT (e.g. Monitor's kill timeout, an operator
  // kill) is NOT the caller's own budget expiring — it is a foreign
  // interruption. It gets its OWN `reason`, the killing signal's name, and a
  // distinct exit code, and is `retryable: "false"` (per `emitPlanFailure`'s
  // vocabulary: re-arming the same await does not undo an external kill) — so
  // forensics never confuses a mass-reap for a wave of self-deadlines.
  const signalFields = (signal: string): Record<string, string> => {
    const detail = lastWaitingDetail();
    return {
      ...deadlineIdentityFields("signal"),
      signal,
      retryable: "false",
      ...(detail !== undefined ? { detail } : {}),
    };
  };

  // SIGTERM/SIGINT → failed reason=signal exit 10 through the same
  // `terminating` guard — distinct from our own `--timeout` (reason=timeout
  // exit 3). Monitor sends SIGTERM at its kill timeout.
  unregisterSignals = deps.installSignals((signal) => {
    emitTerminal("failed", EXIT_SIGNAL, signalFields(signal));
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

  // The give-up policy + injected clock the give-up-eligible streams carry
  // (fn-757). Built ONLY when a deadline is in effect; `null` = no deadline =
  // reconnect-forever, the default. `now` is a test-only clock that rides
  // INSIDE the policy object so it stays paired with `giveUpPolicy` — never
  // forwarded when the flag is unset (otherwise a stranded `now` could drive
  // the driver's give-up anchor with no policy).
  //
  // `--probe` (task 3) implies its OWN bounded connect deadline: an explicit
  // `--connect-timeout` always wins (honored verbatim, exactly as before);
  // bare `--probe` falls back to `PROBE_DEFAULT_CONNECT_TIMEOUT_MS` — a probe
  // that reconnects forever on a down daemon defeats its "evaluate once and
  // exit" purpose. Every non-probe invocation keeps the fn-757 default
  // (reconnect forever, no deadline) exactly as before.
  const effectiveConnectTimeoutMs: number | null =
    args.connectTimeoutMs !== null && args.connectTimeoutMs > 0
      ? args.connectTimeoutMs
      : args.probe
        ? PROBE_DEFAULT_CONNECT_TIMEOUT_MS
        : null;
  const giveUpExtras: {
    giveUpPolicy: GiveUpPolicy;
    now?: () => number;
  } | null =
    effectiveConnectTimeoutMs !== null
      ? {
          giveUpPolicy: { deadlineMs: effectiveConnectTimeoutMs },
          ...(deps.now === undefined ? {} : { now: deps.now }),
        }
      : null;

  // Open ONLY the subscriptions the active conditions need.
  if (openReadiness) {
    readinessHandle = subscribeReadiness({
      sockPath: args.sock,
      idPrefix: `await-${process.pid}`,
      onSnapshot: onReadinessSnapshot,
      onLifecycle: onLifecycle("readiness"),
      onFatal,
      // fn-897 B1 / fn-1015: capture the boot-status header when this stream
      // feeds git rows (git-seed) OR a board condition needs `catching_up`.
      ...(hasGitClean || hasBoard ? { onBootStatus } : {}),
      // fn-1015: merge the recently-done epics so an epic `complete` await reads
      // the close-row `completed` verdict on the present branch. fn-1016: `landed`
      // shares the opt-in — the `landedEpicIds` set is only populated under it (its
      // worktree-OFF degradation reads done epics, which ride this same merge).
      ...(hasComplete || hasLanded ? { includeRecentDoneEpics: true } : {}),
      // ADR 0011: `drained --fail-on-stuck` reads the sticky `dispatch_failures`
      // rows for its jam check off this SAME snapshot — opt in so they ride
      // first-paint instead of a bespoke collection stream. `drained` without
      // `--fail-on-stuck` keeps the byte-identical board scope (flag off).
      ...(openDispatchFailures ? { includeDispatchFailures: true } : {}),
      ...(giveUpExtras ?? {}),
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
      // fn-897 B1: capture the git-seed state from the dedicated git stream.
      onBootStatus,
      ...(giveUpExtras ?? {}),
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
      ...(giveUpExtras ?? {}),
      ...(deps.connect === undefined ? {} : { connect: deps.connect }),
    });
  }
  // `server-up` (fn-750.2): its OWN minimal readiness subscribe that is
  // PERMANENTLY give-up-exempt (reconnect-forever — the slow-cold-boot escape
  // hatch; an explicit `--connect-timeout` is rejected with it at parse
  // time). We don't read any rows off the snapshot; the first `onSnapshot`
  // IS the signal ("the daemon is serving"), so `onServerUpSnapshot` flips
  // the paint flag and `evaluate()`/`evaluateProbe()` latches `met` on first
  // paint. NO give-up extras for the ordinary WAIT form, and NO plan
  // re-query machinery. (fn-757: the give-up-eligible streams above are ALSO
  // exempt unless `--connect-timeout` arms `giveUpExtras`.)
  //
  // `--probe server-up` (task 3) is the one exception: it's an ORDINARY
  // bounded reachability check, not the reconnect-forever WAIT form — it
  // carries `giveUpExtras` (the probe default, since the parse-time
  // exclusivity check above only rejects an EXPLICIT `--connect-timeout`
  // alongside `server-up`) so an unreachable daemon still reports
  // `reason=unreachable` within a bounded deadline instead of hanging.
  if (openServerUp) {
    readinessHandle = subscribeReadiness({
      sockPath: args.sock,
      idPrefix: `await-${process.pid}`,
      onSnapshot: onServerUpSnapshot,
      onLifecycle: onLifecycle("serverUp"),
      onFatal,
      ...(args.probe ? (giveUpExtras ?? {}) : {}),
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

function durableConditionSpec(
  segments: readonly ConditionSegment[],
  gitRoot: string | null,
  drainedScope: DrainedScope,
): DurableAwaitConditionSpec | null {
  const supported = new Set([
    "complete",
    "unblocked",
    "started",
    "git-clean",
    "agents-idle",
    "drained",
    "landed",
    "dead-letter",
    "block-escalation",
    "parked-question",
    "stuck-dispatch",
    "finalize-non-ff",
    "instant-death-wall",
    "needs-human",
  ]);
  const out: DurableAwaitCondition[] = [];
  for (const segment of segments) {
    if (!supported.has(segment.condition)) return null;
    if (
      "target" in segment &&
      typeof segment.target === "object" &&
      segment.target !== null &&
      "id" in segment.target
    )
      out.push({
        condition: segment.condition as DurableAwaitCondition["condition"],
        target: segment.target.id,
      });
    else if (segment.condition === "landed")
      out.push({ condition: "landed", target: segment.target });
    else if (
      segment.condition === "git-clean" ||
      segment.condition === "agents-idle"
    ) {
      if (gitRoot === null) return null;
      out.push({ condition: segment.condition, git_root: gitRoot });
    } else if (segment.condition === "drained")
      out.push({ condition: "drained", scope: drainedScope });
    else
      out.push({
        condition: segment.condition as DurableAwaitCondition["condition"],
        ...(typeof (segment as { since?: unknown }).since === "string"
          ? { since: (segment as { since: string }).since }
          : {}),
      });
  }
  return out;
}

async function listDurableAwaits(sock: string): Promise<void> {
  const rows = await queryCollection(sock, "awaits");
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

const CANCEL_HELP = `keeper await cancel <await-id> [--force]

Retire a WAITING durable await so its follow-up never fires. Only the arming
session may cancel its own await; --force is an audited operator override that
cancels another session's await and records the acting identity. An unknown id,
an already-settled await, and a foreign await all return one uniform
not-cancellable refusal (exit 1); re-cancelling an already-cancelled await is a
no-op success.

  --force        Operator override: cancel an await this session did not arm
  --sock <path>  Socket override ($KEEPER_SOCK / default)
  --help         Show this help
`;

/**
 * `keeper await cancel <await-id>` — send `request_await` `op:'cancel'` with the
 * caller's resolved arming identity so main's producer-side owner fence can
 * authorize it. `--force` requests the audited operator override.
 */
async function cancelDurableAwait(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      force: { type: "boolean" },
      sock: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help === true) {
    process.stdout.write(CANCEL_HELP);
    return;
  }
  const awaitId = positionals[0];
  if (awaitId === undefined || positionals.length !== 1) {
    process.stderr.write(
      "keeper await cancel: exactly one <await-id> is required\n\n",
    );
    process.stderr.write(CANCEL_HELP);
    process.exit(EXIT_USAGE);
  }
  const sock = values.sock ?? resolveSockPath();
  const { session } = resolveSession({ sessionFlag: undefined });
  const rpcId = crypto.randomUUID();
  try {
    const response = await roundTrip(
      sock,
      {
        type: "rpc",
        id: rpcId,
        method: "request_await",
        params: {
          op: "cancel",
          await_id: awaitId,
          caller_session: session,
          ...(values.force === true ? { force: true } : {}),
        },
      },
      rpcId,
    );
    if (response.type !== "rpc_result")
      throw new Error(
        response.type === "error" ? response.message : "unexpected response",
      );
    process.stdout.write(`${JSON.stringify(response.value)}\n`);
    return;
  } catch (err) {
    process.stderr.write(
      `keeper await: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

export async function main(argv: string[]): Promise<void> {
  // `list` is a read-only durable-intent surface, intentionally outside the
  // in-process condition grammar.
  if (argv[0] === "list" || (argv[0] === "--durable" && argv[1] === "list")) {
    await listDurableAwaits(resolveSockPath());
    return;
  }
  // `cancel <await-id>` retires a waiting durable await — likewise outside the
  // condition grammar. The owner fence is enforced producer-side.
  if (argv[0] === "cancel") {
    await cancelDurableAwait(argv.slice(1));
    return;
  }
  const parsed = parseAwaitArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (parsed.message === "__agent_help__") {
      process.stdout.write(AGENT_HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper await: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(parsed.exitCode ?? 1);
  }

  // Side-effect reads (NOT the pure module): resolve cwd→git root only when
  // a condition needs it, and read the self-exclusion session id once.
  const needsRoot = parsed.args.segments.some(
    (s) => s.condition === "git-clean" || s.condition === "agents-idle",
  );
  const gitRoot = needsRoot ? resolveCwdGitRoot() : null;
  const ownSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;

  if (parsed.args.durable) {
    const conditionSpec = durableConditionSpec(
      parsed.args.segments,
      gitRoot,
      parsed.args.scope,
    );
    if (conditionSpec === null) {
      process.stderr.write(
        "keeper await: --durable only supports server-evaluable conditions\n",
      );
      process.exit(EXIT_USAGE);
    }
    const rpcId = crypto.randomUUID();
    const spillDir = resolveAwaitSpillDir();
    mkdirSync(spillDir, { recursive: true });
    const docPath = join(spillDir, `${rpcId}.txt`);
    // The fresh session gets an explicit durable-await handoff, never a pointer
    // to the arming session which may already be gone.
    writeFileSync(
      docPath,
      `A durable keeper await has fired. Re-orient on the board and continue the requested follow-up. Conditions: ${JSON.stringify(conditionSpec)}.`,
      "utf8",
    );
    const { session } = resolveSession({ sessionFlag: undefined });
    try {
      const response = await roundTrip(
        parsed.args.sock,
        {
          type: "rpc",
          id: rpcId,
          method: "request_await",
          params: {
            op: "request",
            await_id: `await-${rpcId}`,
            condition_spec: conditionSpec,
            doc_path: docPath,
            target_session: session,
            target_dir: process.cwd(),
            timeout_ms: parsed.args.timeoutMs,
          },
        },
        rpcId,
      );
      if (response.type !== "rpc_result")
        throw new Error(
          response.type === "error" ? response.message : "unexpected response",
        );
      rmSync(docPath, { force: true });
      process.stdout.write(`${JSON.stringify(response.value)}\n`);
      return;
    } catch (err) {
      process.stderr.write(
        `keeper await: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  await runAwait(parsed.args, {
    writeStdout: (line, cb) => process.stdout.write(line, () => cb()),
    writeStderr: (line) => process.stderr.write(line),
    exit: (code) => process.exit(code),
    installSignals: (handler) => {
      const onTerm = (): void => handler("SIGTERM");
      const onInt = (): void => handler("SIGINT");
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);
      return () => {
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
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
