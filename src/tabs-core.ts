/**
 * tabs-core — the dep-lean engine behind `keeper tabs` (list / restore / dump)
 * and the restore-worker's durable revive side-file.
 *
 * Browser-grade "restore tabs" for keeper-managed Claude Code agents. The engine
 * derives its candidate set RETROSPECTIVELY from a read-only `keeper.db`
 * connection (`src/restore-set.ts`) — no frozen snapshot, no socket round-trip,
 * so the disaster-recovery path is first-class with the daemon DOWN.
 *
 * SELECTION. The default restore set is recency-bounded and RECENCY-FIRST over
 * per-generation `TmuxTopologySnapshot` evidence
 * ({@link enrichedTopologyGenerations}): the auto-pick is the NEWEST eligible DEAD
 * generation — the one you just lost — still rejecting the short-lived single-pane
 * skeleton (degenerate) the naive "newest dead generation" model restored over a
 * rich session. A contested pick (an OLDER in-window generation is substantially
 * richer than the newest pick) surfaces {@link RestoreSelection.ambiguous} so the
 * consumer escalates (a TTY picker) or refuses (a non-TTY offer). Generation
 * identity is keeper-owned — one builder mints every id and a read-time
 * canonicalizer folds a boot observed under two probe formats into one. No
 * restorable dying-generation topology degrades to the retrospective killed-cohort
 * model with a VISIBLE `fallbackNote` banner (never a silent downgrade).
 *
 * RESULT. Each candidate carries a `harness` tag and a harness-native
 * `resume_target`: a claude candidate re-attaches by session UUID
 * (`claude --resume <uuid>`), while Pi resumes via its own `--session` flag off
 * the stored target. A
 * non-claude agent whose target keeper never resolved is reported NOT-RESUMABLE
 * (never launched) so the rest of the generation still restores. The `label` is
 * the latest title (read live from the jobs projection) for display only. The
 * `cwd` prefix on every resume command is load-bearing — a session id resolves
 * only within its project dir plus its git worktrees.
 *
 * DISK-ANCHORED RESUME. The recorded `cwd` is a HINT, not the launch cwd:
 * `planRestore` / `renderSnapshotScript` route every candidate through a
 * {@link ResumeResolver} (`src/resume-resolve.ts`, default real fs) that derives
 * a claude candidate's launch cwd from the transcript on disk (the recorded cwd
 * drifts) and gates a non-claude target on its on-disk artifact. An unresolvable
 * claude transcript becomes a typed PREFLIGHT-FAILED entry (a `#` comment naming
 * the fix, never a doomed `--resume` line); the load-bearing `cd` prefix is
 * repaired to the disk-anchored cwd, never dropped.
 *
 * VERIFIED APPLY. `applyRestore` trusts window creation (the legacy `restored`
 * outcome); `applyRestoreVerified` upgrades each tab to a durable, evidence-proven
 * transaction (`src/restore-verify.ts`): it writes the intent BEFORE the launch,
 * then settles it against on-disk attach evidence — `verified` (cleared),
 * `launched-unverified` (a live pane with no evidence, a warn), or `failed` (a
 * launch or a died resume, resurfaced in `keeper tabs list` until it verifies). An
 * already-live session is an idempotent no-op (never a double-spawn).
 *
 * RESUME-TARGET REPAIR. A pre-fix resume cycle could leave a non-claude job's
 * recorded `resume_target` pointing at a session id no on-disk artifact backs (the
 * rot this epic closes). {@link proposePiRepair} is the shared confidence gate:
 * for a rotted pi row it enumerates the same-cwd pi session files and, on exactly
 * ONE plausible match within the proximity window, proposes the re-pin — two or
 * more is AMBIGUOUS and never resolved. `keeper tabs repair` REPORTS these
 * proposals read-only ({@link loadRepairProposals}); the actual re-pin is landed
 * by the daemon's resume-target back-fill producer, which mints the sanctioned
 * `ResumeTargetResolved` synthetic event —
 * never a direct `jobs` write, never a new RPC surface.
 *
 * This module imports ONLY `src/` peers (no `cli/`), so both `cli/tabs.ts` and the
 * in-daemon restore-worker consume it. Every renderer is pure; the `load*` readers
 * open `keeper.db` read-only in one span; `applyRestore` routes each candidate
 * through keeper's SOLE launch transport (`keeperAgentLaunch` in resume mode, the
 * same seam `keeper dispatch` and `keeper bus wake` use).
 */

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessOrClaude } from "./agent/harness";
import { openDb } from "./db";
import {
  buildKeeperAgentLaunchArgv,
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  buildTmuxServerGenerationArgs,
  keeperAgentLaunch,
  localeDefaultedEnv,
  MANAGED_EXEC_SESSION,
} from "./exec-backend";
import {
  buildLauncherArgvPrefix,
  resolveKeeperAgentPathDepFree,
} from "./keeper-agent-path";
import {
  deriveCurrentSet,
  deriveLastGenerationSet,
  type EnrichedGeneration,
  enrichedTopologyGenerations,
  type GenerationSummary,
  isRestorableCandidate,
  type RestoreCandidate,
  selectGenerationFromEnriched,
} from "./restore-set";
import type {
  AttachIdentity,
  AttachVerifyResult,
  RestoreIntent,
} from "./restore-verify";
import { probeServerGeneration } from "./restore-worker";
import { buildResumeCommand } from "./resume-descriptor";
import {
  defaultResumeResolver,
  nodeResumeResolveFs,
  type ResumeResolveFs,
  type ResumeResolver,
  resolveNonClaudeArtifact,
} from "./resume-resolve";

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
  // A launch that verified against on-disk ATTACH EVIDENCE (a claude SessionStart
  // for the requested session id, or a non-claude birth record on the carried job
  // id) — the only outcome that grants "the tab re-attached". `restored` is the
  // unverified legacy peer (window created, evidence not consulted); `verified` is
  // the {@link applyRestoreVerified} upgrade.
  | { kind: "verified"; candidate: RestoreCandidate }
  // Launched, but no attach evidence appeared inside the verify bound and the pane
  // is still alive — unconfirmed, surfaced as a WARN (never a false verified or a
  // false failed). The tab's intent artifact survives so it resurfaces until it
  // verifies.
  | { kind: "launched-unverified"; candidate: RestoreCandidate; reason: string }
  | { kind: "failed"; candidate: RestoreCandidate; error: string }
  // A candidate keeper cannot resume — a non-claude harness whose native resume
  // target was never resolved, or whose target names no on-disk artifact.
  // Reported (never launched, never counted as a failure), so the REST of the
  // generation still restores.
  | { kind: "not-resumable"; candidate: RestoreCandidate; reason: string }
  // A claude candidate whose transcript could not be disk-anchored to a launch
  // cwd (zero-match, unresolvable multi-match, or a resolved cwd that vanished).
  // No `--resume` line is ever emitted for it; the failure names the found
  // candidates and the one fixing command a human runs. Like `not-resumable`, it
  // is reported (never launched) so the rest of the generation still restores.
  | {
      kind: "preflight-failed";
      candidate: RestoreCandidate;
      reason: string;
      found: string[];
      fixCommand: string;
    };

/**
 * Pure relative to the injected `resolver`: turn the candidate set into the
 * per-agent pre-action plan, narrowed by the optional `--session` filter (matched
 * against the candidate's backend session). Candidates arrive already sorted by
 * visual window order, so this preserves that order.
 *
 * Each candidate is DISK-ANCHORED through the {@link ResumeResolver} (default
 * {@link defaultResumeResolver}, real fs; tests inject a fake):
 *  - A candidate with no resolved resume target ({@link isRestorableCandidate}
 *    false — a non-claude harness keeper never back-filled) is short-circuited to
 *    `"not-resumable"` (reported, never launched).
 *  - A claude candidate's `cwd` is REPLACED by the resolver's disk-anchored one
 *    (the recorded cwd demoted to a hint); an unresolvable transcript becomes a
 *    typed `"preflight-failed"` entry — no doomed `--resume` line.
 *  - A non-claude candidate whose resume target names no on-disk artifact becomes
 *    `"not-resumable"` with a reason.
 * The `--apply` path upgrades each `"would-restore"` to `"restored"` / `"failed"`.
 */
function assertSupportedCandidateHarnesses(
  candidates: readonly RestoreCandidate[],
): void {
  for (const candidate of candidates) {
    harnessOrClaude(candidate.harness);
  }
}

function assertSupportedPlanHarnesses(plan: readonly AgentOutcome[]): void {
  assertSupportedCandidateHarnesses(plan.map((entry) => entry.candidate));
}

export function planRestore(
  candidates: RestoreCandidate[],
  sessionFilter: string | null,
  resolver: ResumeResolver = defaultResumeResolver,
): AgentOutcome[] {
  // Validate the complete set before deriving any per-candidate policy. A stale
  // unregistered harness rejects the restore as one ordinary failure; it cannot
  // become a special not-resumable entry beside a partially actionable plan.
  assertSupportedCandidateHarnesses(candidates);
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
    const res = resolver(candidate);
    if (res.kind === "resolved") {
      out.push({
        kind: "would-restore",
        candidate: { ...candidate, cwd: res.cwd },
      });
    } else if (res.kind === "resumable") {
      out.push({ kind: "would-restore", candidate });
    } else if (res.kind === "not-resumable") {
      out.push({ kind: "not-resumable", candidate, reason: res.reason });
    } else {
      out.push({
        kind: "preflight-failed",
        candidate,
        reason: res.reason,
        found: res.found,
        fixCommand: res.fixCommand,
      });
    }
  }
  return out;
}

/**
 * The launch shape the action loop uses. Real binding routes through
 * `keeperAgentLaunch` in resume mode (keeper's sole launch transport); tests
 * inject a capturing fake so `--apply` can be asserted without spawning a real
 * multiplexer. Carries the RESUME TARGET (not a pre-wrapped argv) — keeper agent
 * builds the `--resume <target>` invocation and owns the tmux window. `jobId` is
 * the candidate's ORIGINAL keeper job id, carried into the resume launch as the
 * identity env so the revived non-claude harness folds onto its existing row
 * (distinct from `resumeTarget`, the harness-native resume key).
 */
export type EnsureLaunchedFn = (
  session: string,
  resumeTarget: string,
  cwd: string,
  harness: string,
  jobId: string,
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
  // Reject the whole externally supplied plan before the first process launch.
  assertSupportedPlanHarnesses(plan);
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
        entry.candidate.job_id,
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

// ---------------------------------------------------------------------------
// Verified apply — the per-tab durable, evidence-verified transaction
// ---------------------------------------------------------------------------

/** Verify one launched candidate against on-disk attach evidence — the injected
 *  seam production wires to {@link import("./restore-verify").verifyAttach} and
 *  tests fake with a fixed result. `launchStartMs` is the wall-clock captured
 *  BEFORE the launch, so the real verify gates evidence on records at/after it
 *  (rejecting a stale pre-crash SessionStart for the same session id). Returns the
 *  verdict PLUS the recycle-safe identity captured from evidence, which the durable
 *  `verified` intent stores for the later no-op gate. */
export type AttachVerifyFn = (
  candidate: RestoreCandidate,
  launchStartMs: number,
) => Promise<AttachVerifyResult>;

/** The durable intent side of the transaction: persist the intent (write-before-
 *  launch, overwrite on each state transition). A `verified` write drops the tab
 *  off the resurface list (verified ∉ the OPEN states) — the "clear" the artifact
 *  contract calls for — while leaving the marker on disk for the live-UUID no-op
 *  (GC reaps it past the idle cutoff). */
export interface IntentSink {
  write(intent: RestoreIntent): void;
}

/** Injected deps for {@link applyRestoreVerified} — every non-pure seam, so the
 *  transaction's state matrix is unit-tested with zero fs / tmux. `makeIntent`
 *  builds the base (attempt-stamped) intent for a candidate; the loop drives its
 *  `state`/`reason` transitions and hands it to `intent`. */
export interface VerifiedApplyDeps {
  ensureLaunched: EnsureLaunchedFn;
  verify: AttachVerifyFn;
  intent: IntentSink;
  makeIntent: (candidate: RestoreCandidate) => RestoreIntent;
  /** Idempotency gate: `true` when the candidate's session is ALREADY LIVE (a
   *  recent attach for its id). A live session is a no-op — the tab is reported
   *  `verified` WITHOUT a relaunch (never a double-spawn) and its intent cleared.
   *  Absent ⇒ always attempt. */
  isLive?: (candidate: RestoreCandidate) => boolean;
  /** Wall-clock (ms) captured before each launch and handed to `verify` as the
   *  evidence recency floor. Default `Date.now`. */
  now?: () => number;
  sleep?: SleepFn;
}

/** The reason strings the verified transaction stamps into a non-verified intent
 *  + its outcome — exported so the CLI + tests key on ONE source of truth. */
export const VERIFY_FAILED_REASON =
  "resume attach failed — pane died with no attach evidence";
export const VERIFY_UNVERIFIED_REASON =
  "launched but attach unconfirmed within the verify bound (pane still alive)";

/**
 * The per-tab VERIFIED restore transaction: for each would-restore candidate,
 * write the durable intent BEFORE the launch (`launched`), drive keeper's launch
 * transport, then VERIFY the attach against on-disk evidence and settle the
 * intent — cleared on `verified`, rewritten `failed` / `launched-unverified`
 * otherwise so the tab resurfaces in `keeper tabs list` until it verifies. A
 * transport failure (or a thrown launch) is `failed` with no verify. Continues
 * past a single tab's failure and paces {@link INTER_WINDOW_PAUSE_MS} between
 * consecutive launches (outside the per-tab try, like {@link applyRestore}).
 * Verification waits overlap after each sequential launch, so one 20-second
 * evidence timeout cannot block every later tab; returned outcomes retain plan
 * order through the ordered promise array.
 */
export async function applyRestoreVerified(
  plan: AgentOutcome[],
  deps: VerifiedApplyDeps,
): Promise<AgentOutcome[]> {
  // Reject the whole externally supplied plan before writing an intent or
  // launching a process; unsupported rows never produce a partial restore.
  assertSupportedPlanHarnesses(plan);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const out: Promise<AgentOutcome>[] = [];
  let launched = 0;
  for (const entry of plan) {
    if (entry.kind !== "would-restore") {
      out.push(Promise.resolve(entry));
      continue;
    }
    const candidate = entry.candidate;
    const cwd = candidate.cwd == null ? "" : seg(candidate.cwd);
    const session = candidate.backend_exec_session_id;
    const base = deps.makeIntent(candidate);
    // Idempotent no-op: an already-live session is reported verified WITHOUT a
    // relaunch, so a repeated apply never double-spawns it. Checked BEFORE the
    // inter-window pause + launch counter so a no-op costs no pacing; the existing
    // verified marker is left untouched.
    if (deps.isLive?.(candidate) === true) {
      out.push(Promise.resolve({ kind: "verified", candidate }));
      continue;
    }
    if (launched > 0) {
      await sleep(INTER_WINDOW_PAUSE_MS);
    }
    launched++;
    // Write-before-launch: the fsynced intent is the crash-safe record of what we
    // are about to do, so a death mid-launch leaves a resumable artifact.
    const launchedIntent = touchIntent(base, "launched", "");
    deps.intent.write(launchedIntent);
    // Capture the evidence floor BEFORE the launch so a SessionStart that fires
    // during the launch still counts (and a stale pre-crash one never does).
    const launchStartMs = now();
    try {
      const res = await deps.ensureLaunched(
        session,
        candidate.resume_target,
        cwd,
        harnessOrClaude(candidate.harness),
        candidate.job_id,
      );
      if (!res.ok) {
        deps.intent.write(touchIntent(base, "failed", res.error));
        out.push(
          Promise.resolve({ kind: "failed", candidate, error: res.error }),
        );
        continue;
      }
      // Begin verification immediately but do not await it before launching the
      // next paced tab. Each task settles its own durable intent and outcome.
      out.push(
        (async (): Promise<AgentOutcome> => {
          try {
            const { verdict, identity } = await deps.verify(
              candidate,
              launchStartMs,
            );
            if (verdict === "verified") {
              // Stamp the verified process's recycle-safe (pid, start_time) handle
              // into the durable intent — the later no-op gate probes THIS, not the
              // bare marker, so a verified-then-died tab is re-observed dead.
              deps.intent.write(touchIntent(base, "verified", "", identity));
              return { kind: "verified", candidate };
            }
            if (verdict === "failed") {
              deps.intent.write(
                touchIntent(base, "failed", VERIFY_FAILED_REASON),
              );
              return {
                kind: "failed",
                candidate,
                error: VERIFY_FAILED_REASON,
              };
            }
            deps.intent.write(
              touchIntent(
                base,
                "launched-unverified",
                VERIFY_UNVERIFIED_REASON,
              ),
            );
            return {
              kind: "launched-unverified",
              candidate,
              reason: VERIFY_UNVERIFIED_REASON,
            };
          } catch (err) {
            const reason = (err as Error).message;
            deps.intent.write(touchIntent(base, "failed", reason));
            return { kind: "failed", candidate, error: reason };
          }
        })(),
      );
    } catch (err) {
      const reason = (err as Error).message;
      deps.intent.write(touchIntent(base, "failed", reason));
      out.push(Promise.resolve({ kind: "failed", candidate, error: reason }));
    }
  }
  return await Promise.all(out);
}

/** Transition an intent to a new state/reason, stamping `updated_at` (a side-file
 *  wall-clock, never a fold input). A `verified` transition carries the captured
 *  `(pid, start_time)` handle; every other transition clears it to null (a
 *  non-verified tab has no live process to probe). Pure over its inputs. */
function touchIntent(
  base: RestoreIntent,
  state: RestoreIntent["state"],
  reason: string,
  identity: AttachIdentity | null = null,
): RestoreIntent {
  return {
    ...base,
    state,
    reason,
    verified_pid: identity?.pid ?? null,
    verified_start_time: identity?.start_time ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** Count each outcome kind in one pass. Exported so the consumer picks the
 *  partial-failure exit code without re-scanning. `verified` is the evidence-proven
 *  peer of the unverified `restored`; `unverified` (launched-unverified) is a WARN,
 *  not a failure. Only `failed` trips the partial-failure exit — neither
 *  `notResumable`, `preflightFailed`, nor `unverified` does (all are expected,
 *  reported non-launch-failures). */
export function countOutcomes(outcomes: AgentOutcome[]): {
  restored: number;
  verified: number;
  failed: number;
  wouldRestore: number;
  unverified: number;
  notResumable: number;
  preflightFailed: number;
} {
  let restored = 0;
  let verified = 0;
  let failed = 0;
  let wouldRestore = 0;
  let unverified = 0;
  let notResumable = 0;
  let preflightFailed = 0;
  for (const o of outcomes) {
    if (o.kind === "restored") restored++;
    else if (o.kind === "verified") verified++;
    else if (o.kind === "failed") failed++;
    else if (o.kind === "launched-unverified") unverified++;
    else if (o.kind === "not-resumable") notResumable++;
    else if (o.kind === "preflight-failed") preflightFailed++;
    else wouldRestore++;
  }
  return {
    restored,
    verified,
    failed,
    wouldRestore,
    unverified,
    notResumable,
    preflightFailed,
  };
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
  const {
    restored,
    verified,
    failed,
    wouldRestore,
    unverified,
    notResumable,
    preflightFailed,
  } = countOutcomes(outcomes);

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
    if (o.kind === "preflight-failed") {
      // No runnable command line — the claude transcript could not be anchored
      // to a launch cwd. Surface the reason, the found candidates, and the one
      // fixing command; never a doomed `--resume` line.
      const foundNote =
        o.found.length > 0
          ? ` [found: ${commentSafe(o.found.join(", "))}]`
          : "";
      stanzas.push(
        `# (${session}) PREFLIGHT-FAILED ${label}: ${commentSafe(o.reason)}${foundNote}\n` +
          `# fix: ${commentSafe(o.fixCommand)}`,
      );
      continue;
    }
    // The resume command is per-harness (Claude --resume / Pi --session),
    // sourced from the candidate's harness tag.
    const cmd = buildResumeCommand(cwd, c.resume_target, null, c.harness);
    if (o.kind === "would-restore") {
      stanzas.push(`# (${session}) would restore ${label}\n${cmd}`);
    } else if (o.kind === "restored") {
      stanzas.push(`# (${session}) restored ${label}\n${cmd}`);
    } else if (o.kind === "verified") {
      stanzas.push(`# (${session}) VERIFIED ${label}\n${cmd}`);
    } else if (o.kind === "launched-unverified") {
      stanzas.push(
        `# (${session}) UNVERIFIED ${label}: ${commentSafe(o.reason)}\n${cmd}`,
      );
    } else {
      stanzas.push(
        `# (${session}) FAILED ${label}: ${commentSafe(o.error)}\n${cmd}`,
      );
    }
  }

  const notResumableNote =
    notResumable > 0 ? ` not-resumable=${notResumable}` : "";
  const preflightNote =
    preflightFailed > 0 ? ` preflight-failed=${preflightFailed}` : "";
  const unverifiedNote = unverified > 0 ? ` unverified=${unverified}` : "";
  // On the verified apply path `verified` supersedes `restored`; sum them so the
  // summary's restored count stays meaningful whichever apply path produced it.
  const applyRestored = restored + verified;
  const summary = apply
    ? `# summary: restored=${applyRestored} failed=${failed}${unverifiedNote}${notResumableNote}${preflightNote}`
    : `# summary: would-restore=${wouldRestore}${notResumableNote}${preflightNote}`;
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
  /** Working directory assigned to any tmux session the script creates. */
  tmuxSessionCwd: string;
  /** Provenance line printed in the header (the keeper.db path the set came from). */
  sourcePath: string;
  /** Count of live panes EXCLUDED from this script (reconciler-managed workers by
   *  default) — surfaced in the header so the human sees what won't be revived. */
  excludedManagedCount?: number;
  /** Disk-anchored resume resolver (default {@link defaultResumeResolver}, real
   *  fs). A claude candidate's `cd` prefix is repaired to the resolver's
   *  disk-anchored cwd; an unresolvable claude transcript or a non-claude target
   *  with no on-disk artifact emits a `#` comment (naming the fix) instead of a
   *  doomed launch line. Tests inject a fake so the render stays pure. */
  resolver?: ResumeResolver;
}

/**
 * Pure renderer: turn a live candidate set into a RUNNABLE bash script that
 * revives each session via the SAME `keeperAgentLaunch` transport `--apply` uses.
 * Each candidate emits the BARE `buildKeeperAgentLaunchArgv` resume argv
 * shell-quoted — byte-aligned with what `--apply` spawns, with NO `tmux
 * new-window` wrapper (keeper agent creates its OWN session+window). A `cd <cwd>
 * &&` prefix sets the directory keeper agent reads from `process.cwd()`. Each
 * session is preceded by a redundant-but-explicit `has-session || new-session`
 * get-or-create guard so the script reads self-contained. The guard sets tmux's
 * session working directory to `options.tmuxSessionCwd`.
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
  const resolver = options.resolver ?? defaultResumeResolver;
  const quoteArgv = (args: string[]): string => args.map(shellQuote).join(" ");
  assertSupportedCandidateHarnesses(candidates);
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
        `${quoteArgv(buildTmuxNewSessionArgs(sessionName, options.tmuxSessionCwd))}`,
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
      // Disk-anchor the resume: a claude candidate's `cd` prefix is repaired to
      // the resolver's on-disk cwd; an unresolvable claude transcript or a
      // non-claude target with no on-disk artifact emits a `#` comment (naming
      // the fix) INSTEAD of a doomed launch line — the `cd` is repaired, never
      // dropped.
      const res = resolver(candidate);
      if (res.kind === "not-resumable") {
        lines.push(
          `# not-resumable: ${commentSafe(candidate.label)} (${commentSafe(res.reason)})`,
        );
        continue;
      }
      if (res.kind === "preflight-failed") {
        const foundNote =
          res.found.length > 0
            ? ` [found: ${commentSafe(res.found.join(", "))}]`
            : "";
        lines.push(
          `# preflight-failed: ${commentSafe(candidate.label)} (${commentSafe(res.reason)})${foundNote}`,
        );
        lines.push(`# fix: ${commentSafe(res.fixCommand)}`);
        continue;
      }
      // `resolved` (claude, disk-anchored cwd) or `resumable` (non-claude, the
      // recorded cwd stands). The BARE keeper agent resume argv — byte-aligned
      // with what --apply spawns. keeper agent owns the session+window, so NO
      // `tmux new-window` wrapper. The harness tag routes `keeper agent <harness>`
      // + that harness's resume verb.
      const cwd =
        res.kind === "resolved"
          ? res.cwd
          : candidate.cwd == null
            ? ""
            : seg(candidate.cwd);
      const launchArgv = buildKeeperAgentLaunchArgv({
        launcherArgvPrefix: options.prefix,
        session: sessionName,
        prompt: "",
        resumeTarget: candidate.resume_target,
        jobId: candidate.job_id,
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

/** A wedged default tmux server degrades the restore-generation read instead of
 * freezing every `keeper tabs` / `keeper setup-tmux` caller. */
const TABS_TMUX_PROBE_TIMEOUT_MS = 5_000;

export interface BoundedGenerationProbeResult {
  readonly success: boolean;
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly exitedDueToTimeout?: boolean;
}

/** Keep an inconclusive timeout/signal distinct from confirmed server absence.
 * `null` tells topology selection that the prior generation is dead; throwing
 * instead prevents a live-but-wedged generation from becoming restorable. */
export function generationFromBoundedProbe(
  result: BoundedGenerationProbeResult,
): string | null {
  if (result.exitedDueToTimeout === true || result.exitCode === null) {
    throw new Error("tmux generation probe timed out or was signal-killed");
  }
  return probeServerGeneration(() => result);
}

export const defaultProbeGeneration: ProbeGenerationFn = () => {
  const result = Bun.spawnSync(buildTmuxServerGenerationArgs(), {
    stdout: "pipe",
    stderr: "ignore",
    timeout: TABS_TMUX_PROBE_TIMEOUT_MS,
    env: localeDefaultedEnv(process.env as Record<string, string | undefined>),
  });
  return generationFromBoundedProbe(result);
};

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
 * Pure: the recency-first generation selection over the enriched topology
 * generations, delegating the auto-pick to the SHARED
 * {@link selectGenerationFromEnriched} so the list a human sees and the set
 * restore offers are ONE computation (structurally incapable of drifting). An
 * explicit `generationId` resolves THAT generation's candidates (no auto-pick);
 * an unknown id sets `unknownGeneration`. Otherwise the auto-pick is the NEWEST
 * eligible DEAD generation (inside the idle cutoff, bounded to the newest
 * {@link RECENT_GENERATION_BOUND}) — the one you just lost; a pick an older
 * in-window generation is substantially richer than is flagged `ambiguous`. No
 * eligible generation returns an empty pick (the caller degrades to the
 * killed-cohort fallback).
 */
export function selectRestoreGeneration(
  enriched: EnrichedGeneration[],
  options: SelectRestoreOptions = {},
): RestoreSelection {
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

  // Auto-pick: the shared recency-first selection — the SAME function the restore
  // deriver runs, so the offer and the list can never disagree.
  const sel = selectGenerationFromEnriched(enriched, {
    now: options.now,
    idleCutoffSecs: options.idleCutoffSecs,
  });
  if (sel.pick === null) {
    return {
      candidates: [],
      pickedGeneration: null,
      eligible: [],
      ambiguous: false,
    };
  }
  return {
    candidates: sel.pick.candidates,
    pickedGeneration: sel.pick.summary,
    eligible: sel.eligible.map((e) => e.summary),
    ambiguous: sel.ambiguous,
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
// Claude attach evidence fallback — raw events-log lines may already be ingested
// ---------------------------------------------------------------------------

/**
 * The re-attached claude process's identity iff the ingested `events` table
 * carries a `SessionStart` for the exact Claude session id at or after the launch
 * floor, else `null`. Restore verification first reads raw events-log NDJSON; this
 * fallback covers the normal daemon race where keeperd has already ingested and
 * cleaned up the per-pid hook file. Returns the NEWEST matching SessionStart's
 * `(pid, start_time)` so the dwell + no-op gate probe a real process. Read-only,
 * daemon-down-safe, and fail-closed to `null` on any open/read error.
 */
export function claudeAttachEvidenceFromDb(
  dbPath: string,
  sessionId: string,
  sinceMs = 0,
): AttachIdentity | null {
  if (sessionId === "") {
    return null;
  }
  try {
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      const gated = Number.isFinite(sinceMs) && sinceMs > 0;
      const row = (
        gated
          ? db
              .query(
                `SELECT pid, start_time FROM events
                  WHERE hook_event = 'SessionStart'
                    AND session_id = ?
                    AND ts >= ?
                  ORDER BY id DESC
                  LIMIT 1`,
              )
              .get(sessionId, sinceMs / 1000)
          : db
              .query(
                `SELECT pid, start_time FROM events
                  WHERE hook_event = 'SessionStart'
                    AND session_id = ?
                  ORDER BY id DESC
                  LIMIT 1`,
              )
              .get(sessionId)
      ) as { pid: number | null; start_time: string | null } | null;
      if (row === null) {
        return null;
      }
      return {
        pid:
          typeof row.pid === "number" && Number.isInteger(row.pid)
            ? row.pid
            : null,
        start_time: typeof row.start_time === "string" ? row.start_time : null,
      };
    } finally {
      try {
        db.close();
      } catch {
        // best-effort; the reader is one-shot.
      }
    }
  } catch {
    return null;
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
    // A not-resumable / preflight-failed entry is never launched, so it can't
    // double-dispatch the managed session.
    if (entry.kind === "not-resumable" || entry.kind === "preflight-failed") {
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
 * re-attaches via `--resume <target>`; cwd is set on the spawn. The candidate's
 * ORIGINAL job id rides the spec so the launch carries the identity env — the
 * revived harness folds onto its existing row, not an orphan. Per-candidate
 * failure isolation rides on the returned LaunchResult verdict.
 */
export function makeEnsureLaunched(
  launcherArgvPrefix: string[],
  noteLine: (line: string) => void,
): EnsureLaunchedFn {
  return (session, resumeTarget, cwd, harness, jobId) =>
    keeperAgentLaunch({
      noteLine,
      launcherArgvPrefix,
      session,
      cwd,
      label: `restore resume ${harness} ${resumeTarget}`,
      spec: { prompt: "", resumeTarget, jobId, harness },
    });
}

// ---------------------------------------------------------------------------
// Resume-target repair — the rotted-pi confidence gate (report + producer share)
// ---------------------------------------------------------------------------

/**
 * Proximity window (ms) a candidate pi session file must fall within of a job's
 * launch instant to be a PLAUSIBLE resume-target replacement. A pi session file
 * is written at launch (≈ the job's `created_at`), so a real match sits within
 * seconds; the window tolerates clock skew + launch latency without admitting an
 * unrelated later session in the same cwd. Exactly one candidate inside the window
 * resolves; two or more is AMBIGUOUS and never auto-resolved (repair must refuse
 * rather than become a new poisoning vector).
 */
export const PI_REPAIR_MATCH_WINDOW_MS = 15 * 60 * 1000;

/** Mirror of the pi transcript-watch producer's cwd → sessions-subdir encoding
 *  (identical to resume-resolve's private `encodePiCwd`): trim the outer slashes,
 *  every `/` → `-`, wrapped in `--…--`. Kept local so this module adds no new
 *  export to resume-resolve. Pure. */
function encodePiRepairCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

/** The pi `sessions/` dirs the existence gate + the matcher share —
 *  `PI_CODING_AGENT_DIR` first (when set), then `~/.pi/agent`. Mirrors
 *  resume-resolve's private `piArtifact` root derivation so a match and its gate
 *  read the same layout. Pure. */
function piRepairSessionsDirs(
  homeDir: string,
  env: Record<string, string | undefined>,
): string[] {
  const roots = [
    (env.PI_CODING_AGENT_DIR ?? "").trim(),
    join(homeDir, ".pi", "agent"),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    if (r === "") {
      continue;
    }
    const d = join(r, "sessions");
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/** Humanize a duration (ms) to a compact `<n>{s,m,h,d}` token for confidence
 *  notes. Pure. */
function humanizeMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Parse a pi session filename `<iso-ts>_<uuid>.jsonl` (e.g.
 * `2026-06-27T02-31-45-766Z_019f06eb-3566-7a6b-a149-f5b6996e30e5.jsonl`) into its
 * resume uuid + the session-start instant the filename encodes. Pi writes the
 * timestamp with `-` for the illegal-in-a-filename time separators (`:` / `.`), so
 * it is rewritten to a parseable ISO string. Returns null for any name that is not
 * this exact shape or whose timestamp does not parse — an untimed file cannot be
 * scored for proximity, so it is never a candidate. Pure.
 */
export function parsePiSessionFileName(
  name: string,
): { uuid: string; createdAtMs: number } | null {
  const m = name.match(
    /^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  if (m === null) {
    return null;
  }
  const rawTs = m[1] as string;
  const uuid = m[2] as string;
  // `YYYY-MM-DDTHH-MM-SS-mmmZ` → `YYYY-MM-DDTHH:MM:SS.mmmZ`.
  const isoTs = rawTs.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "T$1:$2:$3.$4Z",
  );
  const ms = Date.parse(isoTs);
  if (Number.isNaN(ms)) {
    return null;
  }
  return { uuid, createdAtMs: ms };
}

/** One pi session file scored as a resume-target replacement candidate. */
export interface PiRepairCandidate {
  /** The pi session uuid — the resume target a resolved repair re-pins to. */
  uuid: string;
  /** The session-start instant the filename encodes (ms). */
  createdAtMs: number;
  /** `|file start − job start|` (ms) — the proximity score. */
  deltaMs: number;
}

/**
 * Enumerate the pi session files under a job cwd's pi project dir across the pi
 * roots, parsed + scored by proximity to the job's launch instant. Deduped by
 * uuid (a profile may symlink stores) with the CLOSEST occurrence winning; sorted
 * nearest-first (uuid tiebreak). Pure relative to `fs`.
 */
export function collectPiRepairCandidates(
  fs: ResumeResolveFs,
  homeDir: string,
  env: Record<string, string | undefined>,
  cwd: string,
  jobCreatedAtMs: number,
): PiRepairCandidate[] {
  const byUuid = new Map<string, PiRepairCandidate>();
  const sub = encodePiRepairCwd(cwd);
  for (const sessionsDir of piRepairSessionsDirs(homeDir, env)) {
    for (const name of fs.listDir(join(sessionsDir, sub))) {
      const parsed = parsePiSessionFileName(name);
      if (parsed === null) {
        continue;
      }
      const deltaMs = Math.abs(parsed.createdAtMs - jobCreatedAtMs);
      const prev = byUuid.get(parsed.uuid);
      if (prev === undefined || deltaMs < prev.deltaMs) {
        byUuid.set(parsed.uuid, {
          uuid: parsed.uuid,
          createdAtMs: parsed.createdAtMs,
          deltaMs,
        });
      }
    }
  }
  return [...byUuid.values()].sort(
    (a, b) =>
      a.deltaMs - b.deltaMs || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0),
  );
}

/** One pi job the repair sweep considers — a harness-pi row carrying a recorded
 *  resume target that may or may not still name an on-disk artifact. */
export interface PiRepairJob {
  jobId: string;
  /** Display label (latest title, falling back to the job id). */
  label: string;
  cwd: string | null;
  /** The currently recorded resume target (non-empty for a rot candidate). */
  resumeTarget: string;
  /** Job launch instant (ms) — the proximity anchor. */
  createdAtMs: number;
}

/** A resume-target repair proposal for one rotted pi job. `resolved` carries the
 *  single unambiguous re-pin; `ambiguous` lists the plausible candidates but never
 *  resolves; `unmatched` found no plausible replacement. */
export type PiRepairProposal = {
  jobId: string;
  label: string;
  harness: "pi";
  cwd: string | null;
  oldTarget: string;
  note: string;
} & (
  | { kind: "resolved"; newTarget: string; candidate: PiRepairCandidate }
  | { kind: "ambiguous"; candidates: PiRepairCandidate[] }
  | { kind: "unmatched" }
);

/** Options for {@link proposePiRepair} — the home dir + env the pi roots derive
 *  from, plus a test-only proximity-window override. */
export interface PiRepairOptions {
  homeDir: string;
  env: Record<string, string | undefined>;
  /** Proximity-window override (ms); defaults to {@link PI_REPAIR_MATCH_WINDOW_MS}. */
  matchWindowMs?: number;
}

/**
 * The shared confidence gate BOTH `keeper tabs repair` and the daemon back-fill
 * producer read. Returns null when the job's recorded target is NOT rotted (still
 * names an on-disk artifact) or the job carries no target. For a rotted target:
 * exactly ONE plausible same-cwd session within the proximity window `resolved`s;
 * two or more is `ambiguous` (reported, NEVER applied); none is `unmatched`. Pure
 * relative to `fs`.
 */
export function proposePiRepair(
  fs: ResumeResolveFs,
  job: PiRepairJob,
  opts: PiRepairOptions,
): PiRepairProposal | null {
  if (job.resumeTarget === "") {
    return null; // never resolved — no recorded target to re-pin.
  }
  const gate = resolveNonClaudeArtifact(fs, {
    harness: "pi",
    resumeTarget: job.resumeTarget,
    cwd: job.cwd,
    homeDir: opts.homeDir,
    env: opts.env,
  });
  if (gate.kind === "resumable") {
    return null; // target still exists on disk — not rotted.
  }
  const base = {
    jobId: job.jobId,
    label: job.label,
    harness: "pi" as const,
    cwd: job.cwd,
    oldTarget: job.resumeTarget,
  };
  const window = opts.matchWindowMs ?? PI_REPAIR_MATCH_WINDOW_MS;
  const candidates =
    job.cwd == null || job.cwd === ""
      ? []
      : collectPiRepairCandidates(
          fs,
          opts.homeDir,
          opts.env,
          job.cwd,
          job.createdAtMs,
        ).filter((c) => c.uuid !== job.resumeTarget && c.deltaMs <= window);
  if (candidates.length === 1) {
    const c = candidates[0] as PiRepairCandidate;
    return {
      ...base,
      kind: "resolved",
      newTarget: c.uuid,
      candidate: c,
      note: `pi session ${c.uuid} created ${humanizeMs(c.deltaMs)} from job start`,
    };
  }
  if (candidates.length > 1) {
    return {
      ...base,
      kind: "ambiguous",
      candidates,
      note: `${candidates.length} plausible pi sessions within ${humanizeMs(window)} of job start — refusing to auto-resolve`,
    };
  }
  return {
    ...base,
    kind: "unmatched",
    note: `recorded target ${job.resumeTarget} names no on-disk pi session and no plausible replacement was found`,
  };
}

/** Map a rotted-pi job set to its proposals, dropping the non-rotted rows
 *  ({@link proposePiRepair} returns null). Pure relative to `fs`. */
export function sweepPiRepairProposals(
  jobs: PiRepairJob[],
  fs: ResumeResolveFs,
  opts: PiRepairOptions,
): PiRepairProposal[] {
  const out: PiRepairProposal[] = [];
  for (const job of jobs) {
    const proposal = proposePiRepair(fs, job, opts);
    if (proposal !== null) {
      out.push(proposal);
    }
  }
  return out;
}

/** The pi jobs a repair sweep considers: harness pi with a non-empty recorded
 *  resume target (only a set target can rot). LIVE and killed both — the report
 *  surfaces every rotted tab. Newest-first. Pure over the db. */
export function loadPiRepairJobs(db: Database): PiRepairJob[] {
  const rows = db
    .query(
      `SELECT job_id, title, cwd, resume_target, created_at FROM jobs
         WHERE harness = 'pi' AND resume_target IS NOT NULL AND resume_target != ''
         ORDER BY created_at DESC`,
    )
    .all() as {
    job_id: string;
    title: string | null;
    cwd: string | null;
    resume_target: string;
    created_at: number;
  }[];
  return rows.map((r) => ({
    jobId: r.job_id,
    label: r.title ?? r.job_id,
    cwd: r.cwd,
    resumeTarget: r.resume_target,
    createdAtMs: r.created_at * 1000,
  }));
}

/** Options for {@link loadRepairProposals} — all defaulted to production (real fs,
 *  `$HOME`, `process.env`); tests inject a fixture root + fake fs. */
export interface RepairSweepOptions {
  fs?: ResumeResolveFs;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  matchWindowMs?: number;
}

/**
 * `keeper tabs repair`'s read-only sweep: open `keeper.db` read-only in one span,
 * load the pi rot candidates, and return each rotted job's proposal. Daemon-down
 * by design (no socket) — the report never mutates; the re-pin is the daemon
 * producer's job. Re-throws on an open failure.
 */
export function loadRepairProposals(
  dbPath: string,
  opts: RepairSweepOptions = {},
): PiRepairProposal[] {
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    return sweepPiRepairProposals(
      loadPiRepairJobs(db),
      opts.fs ?? nodeResumeResolveFs(),
      {
        homeDir: opts.homeDir ?? homedir(),
        env: opts.env ?? (process.env as Record<string, string | undefined>),
        matchWindowMs: opts.matchWindowMs,
      },
    );
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; the reader is one-shot.
    }
  }
}
