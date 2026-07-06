#!/usr/bin/env bun
/**
 * `keeper tabs <verb>` — browser-grade "restore tabs" for keeper-managed Claude
 * Code agents. Three verbs over the shared dep-lean engine (`src/tabs-core.ts`),
 * every read a daemon-down read-only `keeper.db` open (no socket):
 *
 *   - `list`     — JSON envelope of the per-generation summaries (ranked
 *                  newest-first) plus the current live set. Read-only, exit 0.
 *   - `restore`  — DRY-RUN by default (print the plan, launch nothing); `--apply`
 *                  relaunches each candidate via `keeperAgentLaunch` in resume
 *                  mode. Selection is the recency-bounded, richness-ranked
 *                  generation auto-pick; a contested pick escalates to a numbered
 *                  picker on a TTY and REFUSES (dedicated exit code + ranked
 *                  table) off a TTY. `--generation <id>` targets one generation.
 *   - `dump`     — a runnable revive script for the CURRENT live set on stdout;
 *                  reconciler-managed workers excluded by default
 *                  (`--include-managed` to opt in).
 *
 * Exit codes (slotted into the published `keeper --help --json` table, distinct
 * from the usage code and the await-owned range):
 *   0 — printed the plan / list / dump, or completed the `--apply` restore.
 *   1 — usage/read failure, the autopilot fail-closed gate refusal, or a declined
 *       confirmation (launched nothing).
 *   6 — `restore` refused a non-TTY AMBIGUOUS selection (ranked table on stderr).
 *   7 — `restore --apply` found ZERO candidates without `--allow-empty`.
 *   8 — `restore --apply` had a PARTIAL launch failure (restored/failed summary).
 *
 * The autopilot fail-closed gate is scoped to the managed backend session:
 * `--apply` refuses while autopilot is UNPAUSED only when the restore plan targets
 * that session (restored tabs aren't `verb::id`-named, so a live autopilot may
 * double-dispatch) unless `--force` is passed (which still launches, with a
 * stderr double-dispatch warning). The paused read is daemon-down (last durable
 * state); unknown/absent reads as paused (permissive).
 *
 * Pure decision functions (argv routing, the restore exit-code classifier, the
 * picker parse, the table/summary renderers) are exported so the fast-tier unit
 * tests exercise them without a socket, a real DB, or a TTY.
 */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolveDbPath } from "../src/db";
import type { GenerationSummary } from "../src/restore-set";
import { RECENT_GENERATION_BOUND } from "../src/restore-set";
import {
  applyRestore,
  autopilotGateDecision,
  countOutcomes,
  defaultLauncherPrefix,
  loadCurrentSetForDump,
  loadGenerationList,
  loadRestorePlan,
  makeEnsureLaunched,
  planRestore,
  type RestoreSelection,
  readAutopilotPaused,
  renderOutcomes,
  renderSnapshotScript,
  restorePlanTouchesManagedSession,
} from "../src/tabs-core";
import { keeperTmuxSessionCwd } from "../src/tmux-session-cwd";
import {
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  RECOVERY_DB_READ,
  successEnvelope,
} from "./envelope";

/** The `keeper tabs list` payload schema version. */
export const TABS_LIST_SCHEMA_VERSION = 1;

/** `restore` refused a non-TTY ambiguous selection (policy refusal, distinct from
 *  a runtime failure so an orchestrator can tell the two apart). */
export const TABS_EXIT_REFUSE_AMBIGUOUS = 6;
/** `restore --apply` found zero candidates without `--allow-empty`. */
export const TABS_EXIT_ZERO_CANDIDATES = 7;
/** `restore --apply` had a partial launch failure. */
export const TABS_EXIT_PARTIAL_FAILURE = 8;

const HELP_OVERVIEW = `keeper tabs — restore keeper-managed Claude Code agents after a crash

Usage:
  keeper tabs list                              Ranked dead-generation summaries + live set (JSON)
  keeper tabs restore [--apply] [options]       Dry-run (default) or relaunch the lost session
  keeper tabs dump [--include-managed]          Runnable revive script for the CURRENT live set

Run 'keeper tabs <verb> --help' for a verb's options. All reads open keeper.db
read-only (daemon-down OK). See 'keeper --help --json' for the exit-code table.
`;

const HELP_LIST = `keeper tabs list — ranked dead-generation summaries + the current live set

Usage:
  keeper tabs list [--db <path>]

Emits a {schema_version, ok, error, data} envelope on stdout (exit 0). 'data'
carries 'generations' (the decode-bounded window ranked newest-first — the current
tmux-server generation plus the newest ${RECENT_GENERATION_BOUND} dead ones, not every observed
generation — each with its restorable count, peak pane count, degenerate/current
flags, and a few sample labels) and 'current' (the live working/stopped set).

Flags:
  --db <path>   keeper.db path override ($KEEPER_DB / default otherwise)
  --help, -h    Show this help
`;

const HELP_RESTORE = `keeper tabs restore — restore the session you lost after a crash

Usage:
  keeper tabs restore [--apply] [--generation <id>] [--session <name>]
                      [--allow-empty] [--force] [--db <path>]

DRY-RUN by default: prints the resolved restore plan and touches nothing. The
default selection is the recency-bounded, richness-ranked generation auto-pick
(the newest dead generation with the most restorable agents, skeleton generations
rejected). A contested pick escalates to a numbered picker on a TTY, and REFUSES
off a TTY (exit ${TABS_EXIT_REFUSE_AMBIGUOUS}, ranked table on stderr).

  --apply             Relaunch each candidate via keeper agent (default: DRY-RUN)
  --generation <id>   Restore a specific generation instead of the auto-pick
                      (only within the decode bound: the current generation plus
                      the newest ${RECENT_GENERATION_BOUND} dead ones, as 'keeper tabs list' shows —
                      an older generation is past the bound and unreachable)
  --session <name>    Restore only agents from this backend session
  --allow-empty       Suppress the zero-candidate failure under --apply (exit ${TABS_EXIT_ZERO_CANDIDATES})
  --force             Override the --apply autopilot fail-closed gate (still warns)
  --db <path>         keeper.db path override ($KEEPER_DB / default otherwise)
  --help, -h          Show this help

--apply FAILS CLOSED (exit 1, launches nothing) while autopilot is UNPAUSED only
when the restore plan targets the managed autopilot session, unless --force is passed. Zero candidates under --apply exits ${TABS_EXIT_ZERO_CANDIDATES} (pass --allow-empty to
proceed); any partial launch failure exits ${TABS_EXIT_PARTIAL_FAILURE} with a restored/failed summary.
`;

const HELP_DUMP = `keeper tabs dump — a runnable revive script for the CURRENT live set

Usage:
  keeper tabs dump [--include-managed] [--session <name>] [--db <path>]

Emits a runnable bash script on stdout that revives each live working/stopped
session via the SAME keeper agent resume transport --apply uses. Reconciler-managed
workers (plan_verb='work') are EXCLUDED by default (a revive script is a human
replay surface where they would double-spawn); the header reports how many were
excluded.

  --include-managed   Include reconciler-managed (plan_verb='work') workers
  --session <name>    Emit only this backend session
  --db <path>         keeper.db path override ($KEEPER_DB / default otherwise)
  --help, -h          Show this help
`;

// ---------------------------------------------------------------------------
// Pure argv routing
// ---------------------------------------------------------------------------

/** A parsed `keeper tabs` invocation, or a usage/help signal. Pure shape. */
export type TabsCommand =
  | { kind: "help"; verb: "" | "list" | "restore" | "dump" }
  | { kind: "usage"; error: string }
  | { kind: "list"; db: string | null }
  | {
      kind: "restore";
      apply: boolean;
      generation: string | null;
      session: string | null;
      allowEmpty: boolean;
      force: boolean;
      db: string | null;
    }
  | {
      kind: "dump";
      includeManaged: boolean;
      session: string | null;
      db: string | null;
    };

/** Known `keeper tabs` verbs. */
const VERBS = new Set(["list", "restore", "dump"]);

/**
 * Route a `keeper tabs` argv (already stripped of the `tabs` token) to a command.
 * `--help`/`-h` anywhere → help for the leading verb (or the overview). An unknown
 * verb / arg fault returns a `usage` signal the caller prints to stderr (exit 1).
 * Pure — no I/O.
 */
export function parseTabsArgv(argv: string[]): TabsCommand {
  const verb = argv[0];
  const wantsHelp = argv.some((a) => a === "--help" || a === "-h");
  if (verb === undefined || verb === "--help" || verb === "-h") {
    return { kind: "help", verb: "" };
  }
  if (!VERBS.has(verb)) {
    return { kind: "usage", error: `unknown tabs verb '${verb}'` };
  }
  if (wantsHelp) {
    return { kind: "help", verb: verb as "list" | "restore" | "dump" };
  }
  const rest = argv.slice(1);
  try {
    if (verb === "list") {
      const { values } = parseArgs({
        args: rest,
        options: { db: { type: "string" } },
        allowPositionals: false,
      });
      return { kind: "list", db: values.db ?? null };
    }
    if (verb === "restore") {
      const { values } = parseArgs({
        args: rest,
        options: {
          apply: { type: "boolean", default: false },
          generation: { type: "string" },
          session: { type: "string" },
          "allow-empty": { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          db: { type: "string" },
        },
        allowPositionals: false,
      });
      return {
        kind: "restore",
        apply: values.apply === true,
        generation: values.generation ?? null,
        session: values.session ?? null,
        allowEmpty: values["allow-empty"] === true,
        force: values.force === true,
        db: values.db ?? null,
      };
    }
    // dump
    const { values } = parseArgs({
      args: rest,
      options: {
        "include-managed": { type: "boolean", default: false },
        session: { type: "string" },
        db: { type: "string" },
      },
      allowPositionals: false,
    });
    return {
      kind: "dump",
      includeManaged: values["include-managed"] === true,
      session: values.session ?? null,
      db: values.db ?? null,
    };
  } catch (err) {
    return { kind: "usage", error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Pure restore classifier — the exit-code matrix (refuse/zero/gate/partial)
// ---------------------------------------------------------------------------

/** Inputs to {@link classifyRestore} — everything the terminal decision needs,
 *  none of it I/O. `candidateCount` is post-`--session`-filter. */
export interface RestoreClassifyInput {
  ambiguous: boolean;
  hasExplicitGeneration: boolean;
  tty: boolean;
  apply: boolean;
  allowEmpty: boolean;
  candidateCount: number;
  gate: "proceed" | "blocked" | "forced";
}

/** The terminal restore decision {@link classifyRestore} returns. `picker` and
 *  `refuse-ambiguous` are the ambiguity escalations; the rest are terminal. */
export type RestoreDecision =
  | { kind: "refuse-ambiguous" }
  | { kind: "picker" }
  | { kind: "dry-run" }
  | { kind: "gate-blocked" }
  | { kind: "zero-candidates" }
  | { kind: "confirm-apply" }
  | { kind: "apply" };

/**
 * Pure: decide what a `restore` invocation should do from the resolved selection
 * + flags + environment. Ambiguity (only when no explicit `--generation`)
 * escalates FIRST: a TTY gets the numbered picker, a non-TTY is REFUSED. A
 * dry-run prints the plan. Under `--apply` the autopilot gate is asserted FIRST
 * (even with `--allow-empty`); a blocked gate fails closed. Zero candidates
 * without `--allow-empty` is a failure; with it (or an empty allow-empty set) the
 * apply is a no-op. A TTY apply confirms before launching.
 */
export function classifyRestore(input: RestoreClassifyInput): RestoreDecision {
  if (input.ambiguous && !input.hasExplicitGeneration) {
    return input.tty ? { kind: "picker" } : { kind: "refuse-ambiguous" };
  }
  if (!input.apply) {
    return { kind: "dry-run" };
  }
  // --apply: assert the autopilot gate FIRST (even with --allow-empty / zero).
  if (input.gate === "blocked") {
    return { kind: "gate-blocked" };
  }
  if (input.candidateCount === 0) {
    // Zero candidates: a failure unless --allow-empty suppresses it. With it,
    // there is nothing to confirm — proceed to a no-op apply (exit 0).
    return input.allowEmpty ? { kind: "apply" } : { kind: "zero-candidates" };
  }
  if (input.tty) {
    return { kind: "confirm-apply" };
  }
  return { kind: "apply" };
}

// ---------------------------------------------------------------------------
// Pure renderers — the ranked generation table + the confirm summary
// ---------------------------------------------------------------------------

/** Humanize an age in seconds to a compact `<n>{s,m,h,d}` token. Pure. */
export function formatAge(secs: number): string {
  const s = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Pure: render a numbered menu of generations (the ambiguity picker menu + the
 * non-TTY refusal's ranked table). One line each: `[n] gen <id> — <k> agent(s),
 * <age> ago, peak <p> panes [skeleton] [current]`, newest-first as passed.
 */
export function formatGenerationMenu(
  gens: GenerationSummary[],
  nowSecs: number = Date.now() / 1000,
): string {
  return gens
    .map((g, i) => {
      const age = formatAge(nowSecs - g.last_ts);
      const flags = `${g.degenerate ? " [skeleton]" : ""}${g.is_current ? " [current]" : ""}`;
      return `  [${i + 1}] gen ${g.generation_id} — ${g.restorable} agent(s), ${age} ago, peak ${g.max_pane_count} pane(s)${flags}`;
    })
    .join("\n");
}

/**
 * Pure: parse a numbered-picker answer against a menu of `count` options. A valid
 * 1-based index in range returns its 0-based position; empty / `q` / anything else
 * returns `null` (abort). Pure so the picker parse is unit-tested without a TTY.
 */
export function parsePickerChoice(
  answer: string,
  count: number,
): number | null {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "q") {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    return null;
  }
  return n - 1;
}

/**
 * Pure: the TTY confirm summary for the chosen restore set — the generation's age
 * + count (when the pick is topology-anchored) and the candidate labels. A
 * killed-cohort fallback (no picked generation) reports the set size + labels.
 */
export function formatRestoreConfirmSummary(
  selection: RestoreSelection,
  labels: string[],
  nowSecs: number = Date.now() / 1000,
): string {
  const g = selection.pickedGeneration;
  const head =
    g === null
      ? `Restore ${labels.length} agent(s) from the killed-cohort fallback set:`
      : `Restore ${labels.length} agent(s) from generation ${g.generation_id} (${formatAge(nowSecs - g.last_ts)} ago, peak ${g.max_pane_count} pane(s)):`;
  const body = labels.map((l) => `  - ${l}`).join("\n");
  return labels.length > 0 ? `${head}\n${body}` : head;
}

// ---------------------------------------------------------------------------
// Interactive seams (TTY confirm + numbered picker)
// ---------------------------------------------------------------------------

/** Prompt for a single line on a confirmed TTY; EOF/close resolves empty. Mirrors
 *  setup-tmux's confirm: the readline interface is created + always closed here. */
async function promptLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
      rl.on("close", () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function fail(message: string, code: number): never {
  process.stderr.write(`keeper tabs: ${message}\n`);
  return process.exit(code);
}

function isTty(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

export async function main(argv: string[]): Promise<void> {
  const cmd = parseTabsArgv(argv);

  if (cmd.kind === "help") {
    const text =
      cmd.verb === "list"
        ? HELP_LIST
        : cmd.verb === "restore"
          ? HELP_RESTORE
          : cmd.verb === "dump"
            ? HELP_DUMP
            : HELP_OVERVIEW;
    process.stdout.write(text);
    return process.exit(0);
  }
  if (cmd.kind === "usage") {
    process.stderr.write(`keeper tabs: ${cmd.error}\n\n`);
    process.stderr.write(HELP_OVERVIEW);
    return process.exit(1);
  }

  if (cmd.kind === "list") {
    return runList(cmd.db);
  }
  if (cmd.kind === "dump") {
    return runDump(cmd.includeManaged, cmd.session, cmd.db);
  }
  return runRestore(cmd);
}

/** `keeper tabs list` — the JSON envelope of generation summaries + live set. */
function runList(dbOverride: string | null): never {
  const dbPath = dbOverride ?? resolveDbPath();
  try {
    const payload = loadGenerationList(dbPath);
    emitEnvelope(
      successEnvelope(TABS_LIST_SCHEMA_VERSION, payload),
      processEnvelopeSink,
    );
  } catch {
    emitEnvelope(
      errorEnvelope(TABS_LIST_SCHEMA_VERSION, {
        code: "read_failed",
        message: "keeper.db could not be opened for the tabs list read.",
        recovery: RECOVERY_DB_READ,
      }),
      processEnvelopeSink,
    );
  }
  // emitEnvelope always exits; unreachable.
  return process.exit(0);
}

/** `keeper tabs dump` — the runnable revive script on stdout. */
function runDump(
  includeManaged: boolean,
  session: string | null,
  dbOverride: string | null,
): never {
  const dbPath = dbOverride ?? resolveDbPath();
  let set: ReturnType<typeof loadCurrentSetForDump>;
  try {
    set = loadCurrentSetForDump(dbPath, { includeManaged });
  } catch (err) {
    return fail(
      `failed to open keeper.db for dump: ${(err as Error).message}`,
      1,
    );
  }
  process.stdout.write(
    renderSnapshotScript(set.candidates, {
      sessionFilter: session,
      prefix: defaultLauncherPrefix(),
      tmuxSessionCwd: keeperTmuxSessionCwd(process.env),
      sourcePath: dbPath,
      excludedManagedCount: set.excludedManagedCount,
    }),
  );
  return process.exit(0);
}

/** `keeper tabs restore` — dry-run by default, `--apply` relaunches. */
async function runRestore(cmd: {
  apply: boolean;
  generation: string | null;
  session: string | null;
  allowEmpty: boolean;
  force: boolean;
  db: string | null;
}): Promise<never> {
  const dbPath = cmd.db ?? resolveDbPath();

  let selection: RestoreSelection;
  try {
    selection = loadRestorePlan(dbPath, { generationId: cmd.generation });
  } catch (err) {
    return fail(
      `failed to open keeper.db at ${dbPath}: ${(err as Error).message}`,
      1,
    );
  }

  // An explicit --generation that matched nothing (e.g. reaped between a count
  // and this apply) is a benign empty set, NOT a hard error — the normal
  // zero-candidate path governs the exit code (fail unless --allow-empty).
  if (selection.unknownGeneration !== undefined) {
    process.stderr.write(
      `keeper tabs: [note] generation '${selection.unknownGeneration}' matched no observed generation (it may have been reaped); nothing to restore\n`,
    );
  }

  // Always banner the killed-cohort fallback (a degraded restore is VISIBLE).
  if (selection.fallbackNote !== undefined) {
    process.stderr.write(`keeper tabs: [fallback] ${selection.fallbackNote}\n`);
  }

  const tty = isTty();
  let plan = planRestore(selection.candidates, cmd.session);
  let gate = cmd.apply
    ? autopilotGateDecision(
        readAutopilotPaused(dbPath),
        cmd.force,
        restorePlanTouchesManagedSession(plan),
      )
    : ("proceed" as const);

  let decision = classifyRestore({
    ambiguous: selection.ambiguous,
    hasExplicitGeneration: cmd.generation !== null,
    tty,
    apply: cmd.apply,
    allowEmpty: cmd.allowEmpty,
    candidateCount: plan.length,
    gate,
  });

  // Ambiguity escalation on a TTY: the numbered picker resolves ONE generation,
  // then the flow re-enters as an explicit (non-ambiguous) selection.
  if (decision.kind === "picker") {
    process.stdout.write(
      "Ambiguous restore — the richest generation is not the freshest. Choose one:\n",
    );
    process.stdout.write(`${formatGenerationMenu(selection.eligible)}\n`);
    const answer = await promptLine(
      "Generation to restore (number, or blank to abort): ",
    );
    const idx = parsePickerChoice(answer, selection.eligible.length);
    if (idx === null) {
      return fail("aborted, restored nothing", 1);
    }
    const chosen = selection.eligible[idx] as GenerationSummary;
    try {
      selection = loadRestorePlan(dbPath, {
        generationId: chosen.generation_id,
      });
    } catch (err) {
      return fail(
        `failed to re-read keeper.db at ${dbPath}: ${(err as Error).message}`,
        1,
      );
    }
    plan = planRestore(selection.candidates, cmd.session);
    gate = cmd.apply
      ? autopilotGateDecision(
          readAutopilotPaused(dbPath),
          cmd.force,
          restorePlanTouchesManagedSession(plan),
        )
      : ("proceed" as const);
    decision = classifyRestore({
      ambiguous: false,
      hasExplicitGeneration: true,
      tty,
      apply: cmd.apply,
      allowEmpty: cmd.allowEmpty,
      candidateCount: plan.length,
      gate,
    });
  }

  switch (decision.kind) {
    case "refuse-ambiguous": {
      process.stderr.write(
        "keeper tabs: refusing an AMBIGUOUS restore off a TTY — the richest " +
          "generation is not the freshest. Re-run with --generation <id> " +
          "(pick one below) or on a TTY for the picker:\n",
      );
      process.stderr.write(`${formatGenerationMenu(selection.eligible)}\n`);
      return process.exit(TABS_EXIT_REFUSE_AMBIGUOUS);
    }
    case "dry-run": {
      if (plan.length === 0) {
        process.stdout.write(
          "# keeper tabs restore: no restore candidates (nothing to restore)\n",
        );
      }
      process.stdout.write(renderOutcomes(plan, false, 0));
      return process.exit(0);
    }
    case "gate-blocked": {
      return fail(
        "autopilot is UNPAUSED — refusing to --apply for the managed " +
          "autopilot session (restored tabs aren't 'verb::id'-named, so " +
          "autopilot may double-dispatch). Pause autopilot, restore only a " +
          "human session with --session, or pass --force to override.",
        1,
      );
    }
    case "zero-candidates": {
      return fail(
        "no restore candidates under --apply. Pass --allow-empty to proceed " +
          "with an empty set, or run without --apply to inspect the plan.",
        TABS_EXIT_ZERO_CANDIDATES,
      );
    }
    case "confirm-apply": {
      const labels = plan.map((o) => o.candidate.label);
      process.stdout.write(
        `${formatRestoreConfirmSummary(selection, labels)}\n`,
      );
      const answer = await promptLine("Apply this restore? [y/N] ");
      if (answer.trim().toLowerCase() !== "y") {
        return fail("aborted, restored nothing", 1);
      }
      return runApply(plan, gate, dbPath);
    }
    case "apply": {
      return runApply(plan, gate, dbPath);
    }
    default: {
      // The `picker` kind is resolved above into an explicit selection; a residual
      // one means the eligible set changed underfoot — fail loud, launch nothing.
      return fail("internal error: unresolved restore decision", 1);
    }
  }
}

/** The `--apply` launch loop: warn on a forced gate, relaunch every candidate via
 *  keeper's sole transport, render the outcome summary, and exit 0 (all restored)
 *  or {@link TABS_EXIT_PARTIAL_FAILURE} (any launch failed). */
async function runApply(
  plan: ReturnType<typeof planRestore>,
  gate: "proceed" | "blocked" | "forced",
  _dbPath: string,
): Promise<never> {
  if (gate === "forced") {
    process.stderr.write(
      "keeper tabs: WARNING --force with autopilot UNPAUSED — restored tabs " +
        "aren't 'verb::id'-named; autopilot may double-dispatch this work.\n",
    );
  }
  const ensureLaunched = makeEnsureLaunched(defaultLauncherPrefix(), (l) =>
    process.stderr.write(`${l}\n`),
  );
  const outcomes = await applyRestore(plan, ensureLaunched);
  process.stdout.write(renderOutcomes(outcomes, true, 0));
  const { failed } = countOutcomes(outcomes);
  return process.exit(failed > 0 ? TABS_EXIT_PARTIAL_FAILURE : 0);
}
