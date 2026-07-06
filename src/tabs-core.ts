/**
 * tabs-core — the dep-lean engine behind `keeper tabs` (list / restore / dump)
 * and the restore-worker's durable revive side-file.
 *
 * Browser-grade "restore tabs" for keeper-managed Claude Code agents. The engine
 * derives its candidate set RETROSPECTIVELY from a read-only `keeper.db`
 * connection (`src/restore-set.ts`) — no frozen snapshot, no socket round-trip,
 * so the disaster-recovery path is first-class with the daemon DOWN.
 *
 * SELECTION. The default restore set is recency-bounded and richness-ranked over
 * per-generation `TmuxTopologySnapshot` evidence
 * ({@link enrichedTopologyGenerations}): the auto-pick is the newest DEAD
 * generation with the MOST restorable agents (recency as tiebreak), rejecting the
 * short-lived single-pane skeleton the naive "newest dead generation" model
 * restored over a rich session. A contested pick (the richest set is not the
 * freshest) surfaces {@link RestoreSelection.ambiguous} so the consumer escalates
 * (a TTY picker) or refuses (a non-TTY offer). No restorable dying-generation
 * topology degrades to the retrospective killed-cohort model with a VISIBLE
 * `fallbackNote` banner (never a silent downgrade).
 *
 * RESULT. Each candidate carries a `harness` tag and a harness-native
 * `resume_target`: a claude candidate re-attaches by session UUID
 * (`claude --resume <uuid>`), while codex/pi/hermes resume via their own verb
 * (`codex resume`, `pi --session`, `hermes --resume`) off the stored target. A
 * non-claude agent whose target keeper never resolved is reported NOT-RESUMABLE
 * (never launched) so the rest of the generation still restores. The `label` is
 * the latest title (read live from the jobs projection) for display only. The
 * `cwd` prefix on every resume command is load-bearing — a session id resolves
 * only within its project dir plus its git worktrees.
 *
 * This module imports ONLY `src/` peers (no `cli/`), so both `cli/tabs.ts` and the
 * in-daemon restore-worker consume it. Every renderer is pure; the `load*` readers
 * open `keeper.db` read-only in one span; `applyRestore` routes each candidate
 * through keeper's SOLE launch transport (`keeperAgentLaunch` in resume mode, the
 * same seam `keeper dispatch` and `keeper bus wake` use).
 */

import type { Database } from "bun:sqlite";
import { harnessOrClaude } from "./agent/harness";
import { openDb } from "./db";
import {
  buildKeeperAgentLaunchArgv,
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  keeperAgentLaunch,
  localeDefaultedEnv,
  MANAGED_EXEC_SESSION,
} from "./exec-backend";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "./keeper-agent-path";
import {
  DEFAULT_IDLE_CUTOFF_SECS,
  deriveCurrentSet,
  deriveLastGenerationSet,
  type EnrichedGeneration,
  enrichedTopologyGenerations,
  type GenerationSummary,
  isRestorableCandidate,
  RECENT_GENERATION_BOUND,
  type RestoreCandidate,
} from "./restore-set";
import { probeServerGeneration } from "./restore-worker";
import { buildResumeCommand } from "./resume-descriptor";

const seg = (v: unknown): string => (v == null ? "" : String(v));

// ---------------------------------------------------------------------------
// Outcome shape + plan / apply / render (moved from scripts/restore-agents.ts)
// ---------------------------------------------------------------------------

/**
 * Outcome of one restore attempt — fed into the summary counts and (for the
 * dry-run path) the per-agent label lines. PURE shape — no I/O leaks out. The
 * candidate carries everything the launch needs: `resume_target` (the session-UUID
 * resume key), `backend_exec_session_id` (the tmux session to relaunch into), and
 * `cwd` (the directory the resumed window opens in, set on the `keeperAgentLaunch`
 * spawn).
 */
export type AgentOutcome =
  | { kind: "would-restore"; candidate: RestoreCandidate }
  | { kind: "restored"; candidate: RestoreCandidate }
  | { kind: "failed"; candidate: RestoreCandidate; error: string }
  // A candidate keeper cannot resume — a non-claude harness whose native resume
  // target was never resolved. Reported (never launched, never counted as a
  // failure), so the REST of the generation still restores.
  | { kind: "not-resumable"; candidate: RestoreCandidate; reason: string };

/**
 * Pure: turn the candidate set into the per-agent pre-action plan, narrowed by
 * the optional `--session` filter (matched against the candidate's backend
 * session). Candidates arrive already sorted by visual window order, so this
 * preserves that order. A candidate with no resolved resume target
 * ({@link isRestorableCandidate} false — a non-claude harness keeper never
 * back-filled) becomes a `"not-resumable"` entry (reported, never launched) so
 * the rest of the generation still restores. The `--apply` path upgrades each
 * `"would-restore"` to `"restored"` / `"failed"`.
 */
export function planRestore(
  candidates: RestoreCandidate[],
  sessionFilter: string | null,
): AgentOutcome[] {
  const out: AgentOutcome[] = [];
  for (const candidate of candidates) {
    if (
      sessionFilter !== null &&
      candidate.backend_exec_session_id !== sessionFilter
    ) {
      continue;
    }
    if (!isRestorableCandidate(candidate)) {
      out.push({
        kind: "not-resumable",
        candidate,
        reason: `${harnessOrClaude(candidate.harness)} session has no resolved resume target`,
      });
      continue;
    }
    out.push({ kind: "would-restore", candidate });
  }
  return out;
}

/**
 * The launch shape the action loop uses. Real binding routes through
 * `keeperAgentLaunch` in resume mode (keeper's sole launch transport); tests
 * inject a capturing fake so `--apply` can be asserted without spawning a real
 * multiplexer. Carries the RESUME TARGET (not a pre-wrapped argv) — keeper agent
 * builds the `--resume <target>` invocation and owns the tmux window.
 */
export type EnsureLaunchedFn = (
  session: string,
  resumeTarget: string,
  cwd: string,
  harness: string,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Sleep injection for {@link applyRestore} — production passes the real
 *  `Bun.sleep`, tests pass a no-op so the apply suite never actually waits. */
export type SleepFn = (ms: number) => Promise<void>;

/** Inter-window pacing for restore (ms). Held between consecutive real launches
 *  only — never before the first or after the last. */
export const INTER_WINDOW_PAUSE_MS = 500;

/** Real sleep binding production injects into {@link applyRestore}. */
const defaultSleep: SleepFn = (ms) => Bun.sleep(ms);

/**
 * Drive the plan through `ensureLaunched`, upgrading each `"would-restore"` to
 * `"restored"` or `"failed"`. Continues past a single agent's launch failure
 * (one busted tab shouldn't strand the rest). Pauses {@link INTER_WINDOW_PAUSE_MS}
 * via the injected `sleep` BETWEEN consecutive launches only — the pacing sits
 * OUTSIDE the per-agent try/catch so one launch failure doesn't drop the next
 * agent's pause.
 */
export async function applyRestore(
  plan: AgentOutcome[],
  ensureLaunched: EnsureLaunchedFn,
  sleep: SleepFn = defaultSleep,
): Promise<AgentOutcome[]> {
  const out: AgentOutcome[] = [];
  let launched = 0;
  for (const entry of plan) {
    if (entry.kind !== "would-restore") {
      out.push(entry);
      continue;
    }
    // Pace BETWEEN real launches: pause before every launch after the first.
    if (launched > 0) {
      await sleep(INTER_WINDOW_PAUSE_MS);
    }
    launched++;
    const cwd = entry.candidate.cwd == null ? "" : seg(entry.candidate.cwd);
    const session = entry.candidate.backend_exec_session_id;
    try {
      const res = await ensureLaunched(
        session,
        entry.candidate.resume_target,
        cwd,
        harnessOrClaude(entry.candidate.harness),
      );
      if (res.ok) {
        out.push({ kind: "restored", candidate: entry.candidate });
      } else {
        out.push({
          kind: "failed",
          candidate: entry.candidate,
          error: res.error,
        });
      }
    } catch (err) {
      out.push({
        kind: "failed",
        candidate: entry.candidate,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

/** Count restored / failed / would-restore / not-resumable outcomes in one pass.
 *  Exported so the consumer picks the partial-failure exit code without
 *  re-scanning. `notResumable` is NOT a failure — a not-resumable agent is an
 *  expected, reported skip, so it never trips the partial-failure exit. */
export function countOutcomes(outcomes: AgentOutcome[]): {
  restored: number;
  failed: number;
  wouldRestore: number;
  notResumable: number;
} {
  let restored = 0;
  let failed = 0;
  let wouldRestore = 0;
  let notResumable = 0;
  for (const o of outcomes) {
    if (o.kind === "restored") restored++;
    else if (o.kind === "failed") failed++;
    else if (o.kind === "not-resumable") notResumable++;
    else wouldRestore++;
  }
  return { restored, failed, wouldRestore, notResumable };
}

/**
 * Pure renderer: turn the outcome list into the stdout block. One stanza per
 * agent (a `#` comment label line keyed by the candidate's `label` plus the
 * resume command) followed by a trailing `# summary:` line. When
 * `excludedIdleCount > 0` a trailing note surfaces the idle-excluded count (a
 * false-negative we make visible, never a silent drop).
 */
/**
 * Collapse CR/LF runs to a single space so an agent-influenced value (a job
 * title driving `label`, a session name) interpolated into a `#` comment line
 * cannot break out of the comment into a live, executed line of the generated
 * script. Every comment-line interpolation of such a value routes through here.
 */
export function commentSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function renderOutcomes(
  outcomes: AgentOutcome[],
  apply: boolean,
  excludedIdleCount: number,
): string {
  const stanzas: string[] = [];
  const { restored, failed, wouldRestore, notResumable } =
    countOutcomes(outcomes);

  for (const o of outcomes) {
    const c = o.candidate;
    const cwd = c.cwd == null ? "" : seg(c.cwd);
    const session = commentSafe(c.backend_exec_session_id);
    const label = commentSafe(c.label);
    if (o.kind === "not-resumable") {
      // No runnable command line — the harness has no resolved resume target.
      stanzas.push(
        `# (${session}) NOT-RESUMABLE ${label}: ${commentSafe(o.reason)}`,
      );
      continue;
    }
    // The resume command is per-harness (claude --resume / codex resume /
    // pi --session / hermes --resume), sourced from the candidate's harness tag.
    const cmd = buildResumeCommand(cwd, c.resume_target, null, c.harness);
    if (o.kind === "would-restore") {
      stanzas.push(`# (${session}) would restore ${label}\n${cmd}`);
    } else if (o.kind === "restored") {
      stanzas.push(`# (${session}) restored ${label}\n${cmd}`);
    } else {
      stanzas.push(
        `# (${session}) FAILED ${label}: ${commentSafe(o.error)}\n${cmd}`,
      );
    }
  }

  const notResumableNote =
    notResumable > 0 ? ` not-resumable=${notResumable}` : "";
  const summary = apply
    ? `# summary: restored=${restored} failed=${failed}${notResumableNote}`
    : `# summary: would-restore=${wouldRestore}${notResumableNote}`;
  const idleNote =
    excludedIdleCount > 0
      ? `\n# note: ${excludedIdleCount} crash-like candidate(s) excluded as idle past the cutoff`
      : "";

  return stanzas.length > 0
    ? `${stanzas.join("\n\n")}\n\n${summary}${idleNote}\n`
    : `${summary}${idleNote}\n`;
}

// ---------------------------------------------------------------------------
// Revive script (dump / snapshot-current) — the untrusted-data-to-code boundary
// ---------------------------------------------------------------------------

/**
 * Pure: POSIX single-quote-escape one argv token for safe embedding in the
 * generated revive script. Wraps in single quotes and renders any embedded single
 * quote as the `'\''` close-escape-reopen idiom — the only metacharacter a
 * single-quoted string doesn't already neutralize, so tmux metachars and the
 * resume body's double quotes reach tmux literally. An empty string becomes `''`.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Inputs to {@link renderSnapshotScript}. */
export interface SnapshotScriptOptions {
  /** Narrow the script to one backend session; `null`/absent emits every one. */
  sessionFilter?: string | null;
  /** The absolute `keeper agent` launcher argv prefix (PATH-independent). */
  prefix: string[];
  /** Provenance line printed in the header (the keeper.db path the set came from). */
  sourcePath: string;
  /** Count of live panes EXCLUDED from this script (reconciler-managed workers by
   *  default) — surfaced in the header so the human sees what won't be revived. */
  excludedManagedCount?: number;
}

/**
 * Pure renderer: turn a live candidate set into a RUNNABLE bash script that
 * revives each session via the SAME `keeperAgentLaunch` transport `--apply` uses.
 * Each candidate emits the BARE `buildKeeperAgentLaunchArgv` resume argv
 * shell-quoted — byte-aligned with what `--apply` spawns, with NO `tmux
 * new-window` wrapper (keeper agent creates its OWN session+window). A `cd <cwd>
 * &&` prefix sets the directory keeper agent reads from `process.cwd()`. Each
 * session is preceded by a redundant-but-explicit `has-session || new-session`
 * get-or-create guard so the script reads self-contained.
 *
 * Sessions emit in alpha order; candidates within a session in the visual window
 * order they arrived in. A `sleep 0.5` line separates consecutive launches
 * (tracked globally across session boundaries — never before the first or after
 * the last). Every argv token is single-quoted via {@link shellQuote}. The header
 * reports the captured/excluded counts (`excludedManagedCount`).
 */
export function renderSnapshotScript(
  candidates: RestoreCandidate[],
  options: SnapshotScriptOptions,
): string {
  const sessionFilter = options.sessionFilter ?? null;
  const excludedManagedCount = options.excludedManagedCount ?? 0;
  const quoteArgv = (args: string[]): string => args.map(shellQuote).join(" ");
  const included = candidates.filter(
    (c) =>
      sessionFilter === null || c.backend_exec_session_id === sessionFilter,
  );
  const captured = included.length;
  const excludedNote =
    excludedManagedCount > 0
      ? `${excludedManagedCount} reconciler-managed pane(s) not included (pass --include-managed to add)`
      : "no reconciler-managed panes excluded";
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# keeper tabs dump — runnable snapshot of the CURRENT live keeper agents.",
    `# Source: ${options.sourcePath}. Pipe to a file and run to revive these tabs.`,
    `# captured ${captured} keeper agent(s); ${excludedNote}.`,
    "# Each window relaunches via keeper agent <harness> with that harness's own resume argv; the session is get-or-created.",
    "set -euo pipefail",
  ];
  // Group candidates by backend session, preserving the incoming visual order.
  const bySession = new Map<string, RestoreCandidate[]>();
  for (const c of included) {
    const sess = c.backend_exec_session_id;
    const bucket = bySession.get(sess);
    if (bucket === undefined) {
      bySession.set(sess, [c]);
    } else {
      bucket.push(c);
    }
  }
  let sessionCount = 0;
  // Tracks whether any launch has been emitted yet, ACROSS session boundaries —
  // `sleep 0.5` precedes every launch after the first, so it lands strictly
  // between consecutive launches (no leading or trailing sleep).
  let windowsEmitted = 0;
  for (const sessionName of [...bySession.keys()].sort()) {
    const bucket = bySession.get(sessionName);
    if (bucket === undefined || bucket.length === 0) {
      continue;
    }
    sessionCount++;
    const n = bucket.length;
    lines.push("");
    lines.push(
      `# session: ${commentSafe(sessionName)} (${n} window${n === 1 ? "" : "s"})`,
    );
    // Get-or-create the session up front. keeper agent also mints it, so this is
    // redundant — kept so the script reads self-contained. `|| ` keeps `set -e`
    // from tripping when has-session exits non-zero (session absent).
    lines.push(
      `${quoteArgv(buildTmuxHasSessionArgs(sessionName))} 2>/dev/null || ` +
        `${quoteArgv(buildTmuxNewSessionArgs(sessionName))}`,
    );
    for (const candidate of bucket) {
      // A non-claude agent keeper never back-filled a resume target for is
      // NOT-RESUMABLE — emit a comment (never a broken `--resume ''` line) so the
      // script stays runnable and the rest of the session still revives.
      if (!isRestorableCandidate(candidate)) {
        lines.push(
          `# not-resumable: ${candidate.label} (${harnessOrClaude(candidate.harness)} session has no resolved resume target)`,
        );
        continue;
      }
      const cwd = candidate.cwd == null ? "" : seg(candidate.cwd);
      // The BARE keeper agent resume argv — byte-aligned with what --apply spawns.
      // keeper agent owns the session+window, so NO `tmux new-window` wrapper. The
      // harness tag routes `keeper agent <harness>` + that harness's resume verb.
      const launchArgv = buildKeeperAgentLaunchArgv({
        launcherArgvPrefix: options.prefix,
        session: sessionName,
        prompt: "",
        resumeTarget: candidate.resume_target,
        harness: harnessOrClaude(candidate.harness),
        noConfirm: true,
      });
      if (windowsEmitted > 0) {
        lines.push("sleep 0.5");
      }
      lines.push(`# ${commentSafe(candidate.label)}`);
      // `cd <cwd> &&` sets keeper agent's process.cwd() (the directory it reads for
      // the launch-script `cd`); the --apply path sets it on the spawn instead.
      const cdPrefix = cwd === "" ? "" : `cd ${shellQuote(cwd)} && `;
      lines.push(`${cdPrefix}${quoteArgv(launchArgv)}`);
      windowsEmitted++;
    }
  }
  lines.push("");
  lines.push(
    `# summary: keeper tabs dump sessions=${sessionCount} windows=${windowsEmitted} excluded-managed=${excludedManagedCount}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// G_now probe — the current tmux server generation, for topology-generation exclusion
// ---------------------------------------------------------------------------

/**
 * Probe `G_now` — the CURRENT tmux server generation — at restore time, wrapped
 * in the LOAD-BEARING locale default (a C-locale daemon client corrupts tmux
 * output). Returns the generation string, or `null` when no server is up / the
 * probe degrades. The topology deriver excludes the snapshot of this
 * (still-running) generation, isolating the dying one. Injectable for tests.
 */
export type ProbeGenerationFn = () => string | null;

export const defaultProbeGeneration: ProbeGenerationFn = () =>
  probeServerGeneration((cmd) =>
    Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "ignore",
      env: localeDefaultedEnv(
        process.env as Record<string, string | undefined>,
      ),
    }),
  );

// ---------------------------------------------------------------------------
// Bounded richness-ranked generation selection (the `restore` default)
// ---------------------------------------------------------------------------

/**
 * The resolved restore set plus the metadata the consumer needs to escalate,
 * confirm, or refuse. `candidates` is the set to restore; `pickedGeneration` is
 * the generation they came from (`null` on the killed-cohort fallback);
 * `eligible` is the numbered picker's menu on an ambiguous auto-pick; `ambiguous`
 * flags a contested pick (the richest set is not the freshest); `fallbackNote`
 * is the VISIBLE degraded-restore banner; `unknownGeneration` is set when an
 * explicit `--generation <id>` matched no observed generation.
 */
export interface RestoreSelection {
  candidates: RestoreCandidate[];
  pickedGeneration: GenerationSummary | null;
  eligible: GenerationSummary[];
  ambiguous: boolean;
  fallbackNote?: string;
  unknownGeneration?: string;
}

/** Knobs for {@link selectRestoreGeneration}: the idle/now cutoff plus an optional
 *  explicit `--generation <id>` target (bypasses the auto-pick). */
export interface SelectRestoreOptions {
  now?: number;
  idleCutoffSecs?: number;
  generationId?: string | null;
}

/**
 * Pure: the recency-bounded, richness-ranked generation selection over the
 * enriched topology generations (mirrors
 * {@link deriveLastGenerationSetFromTopology}'s auto-pick so the list a human sees
 * and the set restore offers are computed identically). An explicit
 * `generationId` resolves THAT generation's candidates (no auto-pick); an unknown
 * id sets `unknownGeneration`. Otherwise the auto-pick is the DEAD generation
 * (inside the idle cutoff, bounded to the newest {@link RECENT_GENERATION_BOUND})
 * with the MOST restorable agents, recency as tiebreak; a pick that is not the
 * newest eligible generation is flagged `ambiguous`. No eligible generation
 * returns an empty pick (the caller degrades to the killed-cohort fallback).
 */
export function selectRestoreGeneration(
  enriched: EnrichedGeneration[],
  options: SelectRestoreOptions = {},
): RestoreSelection {
  const now = options.now ?? Date.now() / 1000;
  const idleCutoffSecs = options.idleCutoffSecs ?? DEFAULT_IDLE_CUTOFF_SECS;
  const idleBefore = now - idleCutoffSecs;
  const generationId = options.generationId ?? null;

  // Explicit --generation <id>: resolve THAT generation's candidates verbatim.
  if (generationId !== null && generationId !== "") {
    const hit = enriched.find((e) => e.summary.generation_id === generationId);
    if (hit === undefined) {
      return {
        candidates: [],
        pickedGeneration: null,
        eligible: [],
        ambiguous: false,
        unknownGeneration: generationId,
      };
    }
    return {
      candidates: hit.candidates,
      pickedGeneration: hit.summary,
      eligible: [],
      ambiguous: false,
    };
  }

  // Auto-pick: DEAD (not the current server), newest snapshot inside the idle
  // cutoff, bounded to the newest K (already ranked newest-first).
  const candidateGens = enriched
    .filter((e) => !e.summary.is_current)
    .filter((e) => e.summary.last_ts >= idleBefore)
    .slice(0, RECENT_GENERATION_BOUND);
  const eligible = candidateGens.filter(
    (e) => !e.summary.degenerate && e.summary.restorable > 0,
  );
  if (eligible.length === 0) {
    return {
      candidates: [],
      pickedGeneration: null,
      eligible: [],
      ambiguous: false,
    };
  }

  // MAX restorable, recency (highest last_event_id) as the tiebreak.
  const pick = eligible.reduce((best, e) =>
    e.summary.restorable > best.summary.restorable ||
    (e.summary.restorable === best.summary.restorable &&
      e.summary.last_event_id > best.summary.last_event_id)
      ? e
      : best,
  );
  const newestEligible = eligible.reduce((a, b) =>
    b.summary.last_event_id > a.summary.last_event_id ? b : a,
  );
  const ambiguous =
    pick.summary.generation_id !== newestEligible.summary.generation_id ||
    pick.summary.first_event_id !== newestEligible.summary.first_event_id;

  return {
    candidates: pick.candidates,
    pickedGeneration: pick.summary,
    eligible: eligible.map((e) => e.summary),
    ambiguous,
  };
}

/** The killed-cohort fallback banner — set on {@link RestoreSelection.fallbackNote}
 *  when no restorable dying-generation topology survives. */
export const KILLED_COHORT_FALLBACK_NOTE =
  "no restorable dying-generation topology — using the retrospective " +
  "killed-cohort fallback (restore set may be approximate)";

/** Knobs for {@link loadRestorePlan}: the explicit generation target + the
 *  injectable `G_now` probe (tests pass a fixed generation, production probes tmux). */
export interface LoadRestorePlanOptions {
  generationId?: string | null;
  probeNow?: ProbeGenerationFn;
}

/**
 * Load the restore selection off a read-only `keeper.db` in one open span: probe
 * `G_now`, enrich every generation, and run {@link selectRestoreGeneration}. On an
 * auto-pick with no eligible generation, degrade to the retrospective
 * {@link deriveLastGenerationSet} killed-cohort model and set `fallbackNote` (a
 * VISIBLE degraded-restore banner). Daemon-down by design (no socket). Re-throws
 * on an open failure (the caller maps it to a die/error envelope).
 */
export function loadRestorePlan(
  dbPath: string,
  options: LoadRestorePlanOptions = {},
): RestoreSelection {
  const probeNow = options.probeNow ?? defaultProbeGeneration;
  const currentGenerationId = probeNow();
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const enriched = enrichedTopologyGenerations(db, { currentGenerationId });
    const sel = selectRestoreGeneration(enriched, {
      generationId: options.generationId ?? null,
    });
    // An explicit target (resolved or unknown) or an auto-pick that found an
    // eligible generation returns as-is.
    if (sel.unknownGeneration !== undefined || sel.pickedGeneration !== null) {
      return sel;
    }
    // Auto-pick with no eligible dying-generation topology — degrade to the
    // retrospective killed-cohort model and LABEL it (visible degraded restore).
    const fallback = deriveLastGenerationSet(db);
    return {
      candidates: fallback.candidates,
      pickedGeneration: null,
      eligible: [],
      ambiguous: false,
      fallbackNote: KILLED_COHORT_FALLBACK_NOTE,
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the reader is one-shot.
    }
  }
}

// ---------------------------------------------------------------------------
// list — generation summaries + the current live set
// ---------------------------------------------------------------------------

/** One live keeper agent in the `keeper tabs list` current-set view. */
export interface CurrentLiveEntry {
  job_id: string;
  label: string;
  session: string;
  window_index: number | null;
  cwd: string | null;
}

/** One generation in the `keeper tabs list` view — the {@link GenerationSummary}
 *  plus a few sample display labels from its newest attributed snapshot (a human
 *  hint at what the generation holds). */
export interface GenerationListEntry extends GenerationSummary {
  sample_labels: string[];
}

/** The `keeper tabs list` payload: the decode-bounded generation window ranked
 *  newest-first (the current generation plus the newest
 *  {@link RECENT_GENERATION_BOUND} dead ones, NOT every observed generation) plus
 *  the current live set. */
export interface TabsListPayload {
  generations: GenerationListEntry[];
  current: CurrentLiveEntry[];
}

/** How many candidate labels a list entry samples. */
const SAMPLE_LABEL_LIMIT = 5;

/**
 * Read the `keeper tabs list` payload off a read-only `keeper.db` in one open
 * span: probe `G_now`, enrich the decode-bounded window (the current generation
 * plus the newest {@link RECENT_GENERATION_BOUND} dead ones — summary + sample
 * labels), and snapshot the current live set. Daemon-down OK. Re-throws on an
 * open failure (the caller maps it to an error envelope).
 */
export function loadGenerationList(
  dbPath: string,
  options: { probeNow?: ProbeGenerationFn } = {},
): TabsListPayload {
  const probeNow = options.probeNow ?? defaultProbeGeneration;
  const currentGenerationId = probeNow();
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const generations: GenerationListEntry[] = enrichedTopologyGenerations(db, {
      currentGenerationId,
    }).map((e) => ({
      ...e.summary,
      sample_labels: e.candidates
        .slice(0, SAMPLE_LABEL_LIMIT)
        .map((c) => c.label),
    }));
    const current: CurrentLiveEntry[] = deriveCurrentSet(db).map((c) => ({
      job_id: c.job_id,
      label: c.label,
      session: c.backend_exec_session_id,
      window_index: c.window_index,
      cwd: c.cwd,
    }));
    return { generations, current };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the reader is one-shot.
    }
  }
}

// ---------------------------------------------------------------------------
// dump — the current live set, reconciler-managed workers excluded by default
// ---------------------------------------------------------------------------

/** The current live set for `keeper tabs dump`, plus the count of live panes it
 *  excluded (reconciler-managed workers, unless `--include-managed`). */
export interface DumpCurrentSet {
  candidates: RestoreCandidate[];
  excludedManagedCount: number;
}

/** Read the reconciler-managed (`plan_verb='work'`) live job-id set — the panes
 *  `keeper tabs dump` excludes by default (the reconciler re-dispatches them; a
 *  revive script would double-spawn). */
function loadManagedJobIds(db: Database): Set<string> {
  const rows = db
    .query(
      `SELECT job_id FROM jobs
        WHERE state IN ('working', 'stopped') AND plan_verb = 'work'`,
    )
    .all() as { job_id: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    const id = seg(r.job_id);
    if (id !== "") {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Read the CURRENT live set for `keeper tabs dump` off a read-only `keeper.db`.
 * Reconciler-managed workers (`plan_verb='work'`) are EXCLUDED by default — a
 * revive script is a human replay surface where a reconciler-managed worker would
 * double-spawn — and their count is surfaced (never a silent drop). `--include-
 * managed` (`includeManaged: true`) keeps them. Re-throws on an open failure.
 */
export function loadCurrentSetForDump(
  dbPath: string,
  options: { includeManaged?: boolean } = {},
): DumpCurrentSet {
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const all = deriveCurrentSet(db);
    if (options.includeManaged === true) {
      return { candidates: all, excludedManagedCount: 0 };
    }
    const managed = loadManagedJobIds(db);
    const kept: RestoreCandidate[] = [];
    let excluded = 0;
    for (const c of all) {
      if (managed.has(c.job_id)) {
        excluded++;
      } else {
        kept.push(c);
      }
    }
    return { candidates: kept, excludedManagedCount: excluded };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the reader is one-shot.
    }
  }
}

// ---------------------------------------------------------------------------
// Autopilot fail-closed gate (the --apply guard) — moved verbatim
// ---------------------------------------------------------------------------

/**
 * Read the LAST-DURABLE `autopilot_state.paused` off a read-only `keeper.db` —
 * the `--apply` fail-closed gate's source. Daemon-down by design (NO socket): a
 * recovery tool runs precisely when the daemon is dead, so it reads the durable
 * projection, not live state. Coerces with the `paused ?? true` unknown-is-paused
 * convention: an absent singleton, a non-`1`/`0` value, or any read/open error all
 * resolve to PAUSED (the permissive side). Only a folded `paused = 0` reads as
 * UNPAUSED (the gate-tripping state).
 */
export function readAutopilotPaused(dbPath: string): boolean {
  try {
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      const row = db
        .query("SELECT paused FROM autopilot_state WHERE id = 1")
        .get() as { paused: number | null } | null;
      if (row == null || typeof row.paused !== "number") {
        return true;
      }
      return row.paused !== 0;
    } finally {
      try {
        db.close();
      } catch {
        // best-effort; the reader is one-shot.
      }
    }
  } catch {
    // Open/read failure → treat as PAUSED (permissive): a recovery tool must not
    // wedge because the board can't be read.
    return true;
  }
}

/** The paused-read seam — production passes the real read-only open; tests inject
 *  a fixed verdict so the gate is asserted without a seeded autopilot row. */
export type ReadPausedFn = (dbPath: string) => boolean;

/** True iff a restore plan targets the reconciler-managed backend session. */
export function restorePlanTouchesManagedSession(
  plan: AgentOutcome[],
  managedSession = MANAGED_EXEC_SESSION,
): boolean {
  return plan.some((entry) => {
    if (entry.kind === "not-resumable") {
      return false;
    }
    return entry.candidate.backend_exec_session_id === managedSession;
  });
}

/**
 * Pure: decide the `--apply` autopilot fail-closed gate from the last-durable
 * paused state, the `--force` flag, and whether this restore touches the managed
 * backend session. `"proceed"` — paused (safe), or unpaused while restoring only
 * human sessions. `"blocked"` — unpaused managed-session restore without
 * `--force`: FAIL CLOSED (the caller exits non-zero having launched nothing).
 * `"forced"` — unpaused managed-session restore WITH `--force`: launch anyway,
 * but the caller emits a stderr double-dispatch warning.
 */
export function autopilotGateDecision(
  paused: boolean,
  force: boolean,
  touchesManagedSession = true,
): "proceed" | "blocked" | "forced" {
  if (paused || !touchesManagedSession) {
    return "proceed";
  }
  return force ? "forced" : "blocked";
}

// ---------------------------------------------------------------------------
// Launch wiring — the real `keeperAgentLaunch` resume seam
// ---------------------------------------------------------------------------

/** The absolute `keeper agent` launcher prefix — PATH-independent, so a restored
 *  tab never depends on the `claude` alias. */
export function defaultLauncherPrefix(): string[] {
  return buildLauncherArgvPrefix(
    process.execPath,
    resolveKeeperAgentPathDepFree(),
  );
}

/**
 * Build the real {@link EnsureLaunchedFn}: route every candidate through keeper's
 * sole launch transport — `keeperAgentLaunch` in resume mode (the same seam
 * `keeper bus wake` uses). keeper agent mints/owns the recorded session and
 * re-attaches via `--resume <target>`; cwd is set on the spawn. Per-candidate
 * failure isolation rides on the returned LaunchResult verdict.
 */
export function makeEnsureLaunched(
  launcherArgvPrefix: string[],
  noteLine: (line: string) => void,
): EnsureLaunchedFn {
  return (session, resumeTarget, cwd, harness) =>
    keeperAgentLaunch({
      noteLine,
      launcherArgvPrefix,
      session,
      cwd,
      label: `restore resume ${harness} ${resumeTarget}`,
      spec: { prompt: "", resumeTarget, harness },
    });
}
