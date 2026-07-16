/**
 * `keeper tabs` tests — the crash-restore engine (`src/tabs-core.ts`) and the
 * CLI's pure decision surface (`cli/tabs.ts`).
 *
 * Ported from the retired `restore-agents` suite against the MOVED core (injected
 * fakes, no real tmux), plus the new bounded-selection / exit-code-matrix / argv
 * coverage this epic adds:
 *  - engine: renderSnapshotScript, planRestore, applyRestore, renderOutcomes,
 *    countOutcomes, the autopilot gate, and the read-only load* readers over a
 *    seeded keeper.db (daemon-down, no socket).
 *  - selection: selectRestoreGeneration — the recency-first auto-pick that
 *    restores the just-lost generation (skipping the 1-pane skeleton), the
 *    older-substantially-richer ambiguity flag, and explicit --generation targeting.
 *  - CLI: parseTabsArgv routing, classifyRestore (refuse/zero/gate/partial/
 *    allow-empty), parsePickerChoice, and the table/summary renderers.
 *
 * `main()`'s I/O wiring (process.exit, TTY readline) is NOT driven here — the same
 * shape every other one-shot CLI test uses.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRestore,
  formatAge,
  formatGenerationMenu,
  formatRestoreConfirmSummary,
  parsePickerChoice,
  parseTabsArgv,
  AGENT_HELP as TABS_AGENT_HELP,
  TABS_EXIT_PARTIAL_FAILURE,
  TABS_EXIT_ZERO_CANDIDATES,
} from "../cli/tabs";
import { harnessOrClaude } from "../src/agent/harness";
import {
  PI_RESUME_REPAIR_RECENT_WINDOW_SEC,
  resolvePiResumeRepairs,
} from "../src/daemon";
import { drain } from "../src/reducer";
import type {
  EnrichedGeneration,
  GenerationSummary,
  RestoreCandidate,
} from "../src/restore-set";
import {
  type AttachVerifyResult,
  RESTORE_INTENT_SCHEMA_VERSION,
  type RestoreIntent,
} from "../src/restore-verify";
import type { ResumeResolver } from "../src/resume-resolve";
import {
  type AgentOutcome,
  applyRestore,
  applyRestoreVerified,
  autopilotGateDecision,
  claudeAttachEvidenceFromDb,
  countOutcomes,
  generationFromBoundedProbe,
  type IntentSink,
  loadCurrentSetForDump,
  loadGenerationList,
  loadRepairProposals,
  loadRestorePlan,
  parsePiSessionFileName,
  planRestore as planRestoreRaw,
  type RestoreSelection,
  readAutopilotPaused,
  renderOutcomes,
  renderSnapshotScript as renderSnapshotScriptRaw,
  restorePlanTouchesManagedSession,
  selectRestoreGeneration,
  VERIFY_FAILED_REASON,
  VERIFY_UNVERIFIED_REASON,
} from "../src/tabs-core";
import { freshDbFile } from "./helpers/template-db";

/**
 * A passthrough resume resolver for the ported render/plan tests: it keeps the
 * pre-disk-anchoring behavior (a claude candidate resolves to its recorded cwd,
 * a non-claude restorable candidate is resumable) so those tests assert the
 * SCRIPT/PLAN shape without a real `~/.claude` fixture — the disk-anchoring
 * behavior itself is covered by `test/resume-resolve.test.ts` and the dedicated
 * cases below. An empty-target candidate never reaches the resolver (it is
 * short-circuited to not-resumable), so this need not handle it.
 */
const passResolver: ResumeResolver = (c) =>
  harnessOrClaude(c.harness) === "claude"
    ? { kind: "resolved", cwd: c.cwd ?? "" }
    : { kind: "resumable" };

/** The ported suites call these two through the passthrough resolver by default;
 *  the disk-anchoring tests pass an explicit resolver / options. */
function planRestore(
  candidates: Parameters<typeof planRestoreRaw>[0],
  sessionFilter: Parameters<typeof planRestoreRaw>[1],
  resolver: ResumeResolver = passResolver,
): ReturnType<typeof planRestoreRaw> {
  return planRestoreRaw(candidates, sessionFilter, resolver);
}

function renderSnapshotScript(
  candidates: Parameters<typeof renderSnapshotScriptRaw>[0],
  options: Parameters<typeof renderSnapshotScriptRaw>[1],
): string {
  return renderSnapshotScriptRaw(candidates, {
    resolver: passResolver,
    ...options,
  });
}

const RECENT = Math.floor(Date.now() / 1000) - 60;

let tmpDir: string;
let dbPath: string;
let kdb: ReturnType<typeof freshDbFile>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-tabs-test-"));
  dbPath = join(tmpDir, "keeper.db");
  kdb = freshDbFile(dbPath);
});

afterEach(() => {
  try {
    kdb.db.close();
  } catch {
    // best-effort
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface SeedJob {
  job_id: string;
  state?: string;
  close_kind?: string | null;
  window_index?: number | null;
  title?: string | null;
  cwd?: string | null;
  created_at?: number;
  updated_at?: number;
  backend_exec_session_id?: string | null;
  plan_verb?: string | null;
  last_event_id?: number | null;
  harness?: string | null;
  resume_target?: string | null;
}

function seedJob(db: Database, j: SeedJob): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, title, cwd, close_kind,
       window_index, backend_exec_session_id, plan_verb, last_event_id,
       harness, resume_target
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      j.job_id,
      j.created_at ?? RECENT,
      j.updated_at ?? RECENT,
      j.state ?? "killed",
      j.title ?? null,
      j.cwd ?? null,
      j.close_kind ?? null,
      j.window_index ?? null,
      "backend_exec_session_id" in j
        ? (j.backend_exec_session_id ?? null)
        : "work",
      j.plan_verb ?? null,
      j.last_event_id ?? null,
      j.harness ?? null,
      j.resume_target ?? null,
    ],
  );
}

function seedBackendExecStart(db: Database, id: number): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'backend-exec-start', 'BackendExecStart', 'backend_exec_start', ?)`,
    [
      id,
      RECENT,
      JSON.stringify({ backend_type: "tmux", generation_id: `gen-${id}` }),
    ],
  );
}

function seedTmuxTopologySnapshot(
  db: Database,
  id: number,
  generationId: string,
  panes: {
    pane_id: string;
    session_name: string;
    window_index?: number | null;
    job_id?: string;
  }[],
): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [
      id,
      RECENT,
      JSON.stringify({
        generation_id: generationId,
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          session_name: p.session_name,
          window_index: p.window_index ?? null,
          ...(p.job_id !== undefined ? { job_id: p.job_id } : {}),
        })),
      }),
    ],
  );
}

function seedAutopilotPaused(db: Database, paused: number): void {
  db.run(
    `INSERT OR REPLACE INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?)`,
    [paused, RECENT, RECENT],
  );
}

test("claudeAttachEvidenceFromDb reads ingested SessionStart identity with recency gate", () => {
  kdb.db.run(
    `INSERT INTO events (ts, session_id, pid, start_time, hook_event, event_type, data)
       VALUES (?, 'wanted', 6161, 'darwin:db', 'SessionStart', 'session_start', '{}')`,
    [RECENT],
  );

  // A fresh-enough match returns the row's (pid, start_time) identity.
  expect(
    claudeAttachEvidenceFromDb(dbPath, "wanted", (RECENT - 1) * 1000),
  ).toEqual({ pid: 6161, start_time: "darwin:db" });
  // Too-new a floor rejects the stale record; a different id never matches.
  expect(
    claudeAttachEvidenceFromDb(dbPath, "wanted", (RECENT + 1) * 1000),
  ).toBeNull();
  expect(
    claudeAttachEvidenceFromDb(dbPath, "other", (RECENT - 1) * 1000),
  ).toBeNull();
});

function fakeCandidate(opts: {
  job_id: string;
  resume_target?: string;
  label?: string;
  window_index?: number | null;
  cwd?: string | null;
  backend_exec_session_id?: string;
  created_at?: number;
  harness?: string;
}): RestoreCandidate {
  return {
    job_id: opts.job_id,
    resume_target: opts.resume_target ?? opts.job_id,
    label: opts.label ?? opts.job_id,
    window_index: opts.window_index ?? null,
    cwd: "cwd" in opts ? (opts.cwd ?? null) : "/repo",
    backend_exec_session_id: opts.backend_exec_session_id ?? "work",
    created_at: opts.created_at ?? 1000,
    ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
  };
}

/** A GenerationSummary fixture with sensible defaults for the pure selection tests. */
function gen(
  opts: Partial<GenerationSummary> & { generation_id: string },
): GenerationSummary {
  return {
    generation_id: opts.generation_id,
    first_event_id: opts.first_event_id ?? 1,
    last_event_id: opts.last_event_id ?? 100,
    snapshot_count: opts.snapshot_count ?? 1,
    first_ts: opts.first_ts ?? RECENT,
    last_ts: opts.last_ts ?? RECENT,
    max_pane_count: opts.max_pane_count ?? 1,
    is_current: opts.is_current ?? false,
    degenerate: opts.degenerate ?? false,
    restorable: opts.restorable ?? 0,
  };
}

/** An EnrichedGeneration whose summary.restorable matches its candidate count. */
function enriched(
  summary: GenerationSummary,
  candidates: RestoreCandidate[],
): EnrichedGeneration {
  return {
    summary: { ...summary, restorable: candidates.length },
    candidates,
    unregisteredHarnessSkipCount: 0,
  };
}

const RESTORE_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"];
const RESTORE_TMUX_SESSION_CWD = "/home/tester";

// ---------------------------------------------------------------------------
// renderSnapshotScript — the dump revive script
// ---------------------------------------------------------------------------

test("renderSnapshotScript emits a get-or-create guard + paced BARE keeper agent resume argv", () => {
  const candidates = [
    fakeCandidate({
      job_id: "j1",
      resume_target: "first-name",
      label: "first-name",
      cwd: "/repo/a",
      window_index: 1,
    }),
    fakeCandidate({
      job_id: "j2",
      resume_target: "second-name",
      label: "second-name",
      cwd: "/repo/b",
      window_index: 2,
    }),
  ];
  const script = renderSnapshotScript(candidates, {
    prefix: RESTORE_PREFIX,
    tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
    sourcePath: "/tmp/keeper.db",
  });
  expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  expect(script).toContain("set -euo pipefail");
  expect(script).toContain("'tmux' 'has-session' '-t' '=work'");
  expect(script).toContain(
    "'tmux' 'new-session' '-d' '-s' 'work' '-c' '/home/tester'",
  );
  // BARE keeper agent resume argv — no `tmux new-window` wrapper; cwd via `cd`.
  expect(script).not.toContain("'tmux' 'new-window'");
  expect(script).toContain("cd '/repo/a' && '/abs/bun' '/abs/cli/keeper.ts'");
  expect(script).toContain("'--resume' 'first-name'");
  expect(script).toContain("'--resume' 'second-name'");
  // The revive script carries the ORIGINAL job identity per line so a revived
  // non-claude harness folds onto its existing row — the job id rides as the
  // KEEPER_JOB_ID env carrier, never as the (name-based) resume target.
  expect(script).toContain("'KEEPER_JOB_ID=j1'");
  expect(script).toContain("'KEEPER_JOB_ID=j2'");
  expect(script).not.toContain("'--resume' 'j1'");
  expect(script).not.toContain("'--resume' 'j2'");
  // Exactly one inter-launch pause (between the two; none leading/trailing).
  expect(script.match(/^sleep 0\.5$/gm) ?? []).toHaveLength(1);
  expect(script).toContain(
    "# summary: keeper tabs dump sessions=1 windows=2 excluded-managed=0",
  );
});

test("renderSnapshotScript header reports captured + excluded-managed counts", () => {
  const script = renderSnapshotScript(
    [fakeCandidate({ job_id: "j", resume_target: "n", label: "n" })],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
      excludedManagedCount: 3,
    },
  );
  expect(script).toContain("# captured 1 keeper agent(s);");
  expect(script).toContain(
    "3 reconciler-managed pane(s) not included (pass --include-managed to add).",
  );
  expect(script).toContain("excluded-managed=3");
});

test("renderSnapshotScript comments and counts unregistered harness candidates", () => {
  const script = renderSnapshotScript(
    [
      fakeCandidate({ job_id: "ok", resume_target: "ok", label: "ok" }),
      fakeCandidate({
        job_id: "retired",
        harness: "codex",
        resume_target: "legacy-target",
        label: "retired",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
    },
  );
  expect(script).toContain(
    "# unsupported-harness: retired (unknown harness 'codex')",
  );
  expect(script).toContain("unsupported-harness=1");
  expect(script).toContain("windows=1");
});

test("renderSnapshotScript is byte-aligned with what --apply spawns (bare keeper agent argv)", () => {
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "j",
        resume_target: "name",
        label: "name",
        cwd: "/repo",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
    },
  );
  expect(script).toContain(
    "cd '/repo' && '/abs/bun' '/abs/cli/keeper.ts' 'agent' 'claude' " +
      "'--x-tmux' '--x-tmux-detached' '--x-tmux-session' " +
      "'work' '--x-tmux-env' 'KEEPER_TMUX_SESSION=work' " +
      "'--x-tmux-env' 'KEEPER_PLAN_WORKTREE=' " +
      "'--x-tmux-env' 'KEEPER_PLAN_WORKTREE_BRANCH=' " +
      // The dumped resume line carries the identity env (candidate.job_id),
      // byte-aligned with what --apply spawns for the same candidate.
      "'--x-tmux-env' 'KEEPER_JOB_ID=j' " +
      "'--x-tmux-env' 'KEEPER_ESCALATION_ROLE=' " +
      // The three always-present dispatched-cell carriers (ADR 0047), EMPTY on a
      // resume line (byte-aligned with what --apply spawns).
      "'--x-tmux-env' 'KEEPER_PLAN_DISPATCHED_MODEL=' " +
      "'--x-tmux-env' 'KEEPER_PLAN_DISPATCHED_TIER=' " +
      "'--x-tmux-env' 'KEEPER_PLAN_DISPATCH_CONSTRAINT=' " +
      // The two always-present wrapped-cell guard carriers (task .1), EMPTY on a
      // resume line (byte-aligned with what --apply spawns).
      "'--x-tmux-env' 'KEEPER_WRAPPED_CELL=' " +
      "'--x-tmux-env' 'KEEPER_WRAPPED_ENVELOPE=' " +
      "'--permission-mode' 'acceptEdits' '--dangerously-skip-permissions' " +
      "'--x-no-confirm' '--resume' 'name'",
  );
  expect(script).not.toContain('"$@"');
  expect(script).not.toContain("exec ");
});

test("renderSnapshotScript: a resume target with shell metacharacters is single-quoted", () => {
  const nasty = [
    "single ' quote",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the adversarial byte content under test
    "$VAR and ${BRACED}",
    "back`tick`s",
    "$(rm -rf /)",
    "semis ; and && pipes |",
    "-leading-dash",
  ].join(" :: ");
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "x",
        resume_target: nasty,
        label: "x",
        cwd: "/repo",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
    },
  );
  const quoted = `'${nasty.replace(/'/g, `'\\''`)}'`;
  expect(script).toContain(`'--resume' ${quoted}`);
});

/**
 * The script text bash would actually execute: walk lines with a
 * single-quote-aware scanner, dropping comment lines (a line whose first
 * non-blank char is an unquoted `#` runs to EOL and never parses quotes —
 * so a prose apostrophe in a comment can't shift parity) and the interiors
 * of single-quoted spans (which legally span lines and are inert). Returns
 * one entry per executable line: its unquoted remainder.
 */
function executableRemainders(script: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  for (const line of script.split("\n")) {
    if (!inQuote && line.trimStart().startsWith("#")) {
      continue;
    }
    let bare = "";
    for (const ch of line) {
      if (ch === "'") {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote) {
        bare += ch;
      }
    }
    out.push(bare);
  }
  return out;
}

test("renderSnapshotScript: a newline in label AND session stays inside its # comment, never a live line", () => {
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "j",
        resume_target: "name",
        // Agent-influenced job title carrying a newline + a live command.
        label: "harmless\nrm -rf ~/precious",
        cwd: "/repo",
        backend_exec_session_id: "work\ntouch /tmp/pwned",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
    },
  );
  // Both agent-influenced values fold onto a single `#` comment line each.
  expect(script).toContain("# harmless rm -rf ~/precious");
  expect(script).toContain("# session: work touch /tmp/pwned (1 window)");
  // Assert no injected payload survives on an executable line: nothing
  // escaped its comment.
  for (const line of executableRemainders(script)) {
    expect(line.includes("rm -rf ~/precious")).toBe(false);
    expect(line.includes("touch /tmp/pwned")).toBe(false);
  }
});

test("renderOutcomes: a newline in label AND session stays inside its # comment", () => {
  const out = renderOutcomes(
    [
      {
        kind: "would-restore",
        candidate: fakeCandidate({
          job_id: "j",
          resume_target: "name",
          label: "harmless\nrm -rf ~/precious",
          cwd: "/repo",
          backend_exec_session_id: "work\ntouch /tmp/pwned",
        }),
      },
    ],
    false,
    0,
  );
  expect(out).toContain(
    "# (work touch /tmp/pwned) would restore harmless rm -rf ~/precious",
  );
  const bare = out.replace(/'[^']*'/g, "");
  for (const line of bare.split("\n")) {
    if (line.startsWith("#")) {
      continue;
    }
    expect(line.includes("rm -rf ~/precious")).toBe(false);
    expect(line.includes("touch /tmp/pwned")).toBe(false);
  }
});

test("renderOutcomes: a newline in the FAILED-branch error stays inside its # comment", () => {
  const out = renderOutcomes(
    [
      {
        kind: "failed",
        candidate: fakeCandidate({
          job_id: "j",
          resume_target: "name",
          label: "some-agent",
          cwd: "/repo",
          backend_exec_session_id: "work",
        }),
        error: "boom\nrm -rf ~/x",
      },
    ],
    true,
    0,
  );
  expect(out).toContain("# (work) FAILED some-agent: boom rm -rf ~/x");
  for (const line of executableRemainders(out)) {
    expect(line.includes("rm -rf ~/x")).toBe(false);
  }
});

test("renderSnapshotScript --session filter narrows to one bucket", () => {
  const candidates = [
    fakeCandidate({
      job_id: "a",
      resume_target: "a-name",
      label: "a-name",
      backend_exec_session_id: "work",
    }),
    fakeCandidate({
      job_id: "b",
      resume_target: "b-name",
      label: "b-name",
      backend_exec_session_id: "other",
    }),
  ];
  const script = renderSnapshotScript(candidates, {
    sessionFilter: "other",
    prefix: RESTORE_PREFIX,
    tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
    sourcePath: "/tmp/keeper.db",
  });
  expect(script).toContain("'--resume' 'b-name'");
  expect(script).not.toContain("'--resume' 'a-name'");
  expect(script).toContain(
    "# summary: keeper tabs dump sessions=1 windows=1 excluded-managed=0",
  );
});

// ---------------------------------------------------------------------------
// planRestore / applyRestore / renderOutcomes / countOutcomes (ported)
// ---------------------------------------------------------------------------

test("planRestore marks every candidate would-restore by default", () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  expect(plan.map((p) => p.kind)).toEqual(["would-restore", "would-restore"]);
});

test("planRestore respects the --session filter", () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", backend_exec_session_id: "autopilot" }),
      fakeCandidate({ job_id: "b", backend_exec_session_id: "side" }),
    ],
    "autopilot",
  );
  expect(plan).toHaveLength(1);
  expect(plan[0].candidate.job_id).toBe("a");
});

test("planRestore preserves the candidate input order", () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "first", window_index: 0 }),
      fakeCandidate({ job_id: "second", window_index: 1 }),
      fakeCandidate({ job_id: "third", window_index: 2 }),
    ],
    null,
  );
  expect(plan.map((p) => p.candidate.job_id)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

test("applyRestore launches each would-restore via ensureLaunched, carrying the resume target", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", resume_target: "a-name", cwd: "/repo/a" }),
      fakeCandidate({ job_id: "b", resume_target: "b-name", cwd: "/repo/b" }),
    ],
    null,
  );
  const calls: {
    session: string;
    resumeTarget: string;
    cwd: string;
    jobId: string;
  }[] = [];
  const out = await applyRestore(
    plan,
    async (session, resumeTarget, cwd, _harness, jobId) => {
      calls.push({ session, resumeTarget, cwd, jobId });
      return { ok: true };
    },
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls[0]).toEqual({
    session: "work",
    resumeTarget: "a-name",
    cwd: "/repo/a",
    // The candidate's ORIGINAL job id is threaded through so the launch carries
    // the identity env (distinct from the resume target).
    jobId: "a",
  });
  expect(calls[1].resumeTarget).toBe("b-name");
  expect(calls[1].jobId).toBe("b");
});

test("applyRestore continues past a single agent's launch failure", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "fail" }), fakeCandidate({ job_id: "ok" })],
    null,
  );
  const out = await applyRestore(
    plan,
    async (_session, resumeTarget) =>
      resumeTarget === "fail"
        ? { ok: false, error: "keeper agent launch no-op (exit 3 NOOP)" }
        : { ok: true },
    async () => {},
  );
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe(
    "keeper agent launch no-op (exit 3 NOOP)",
  );
  expect(out[1].kind).toBe("restored");
});

test("applyRestore traps a thrown ensureLaunched and marks the entry failed", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "boom" })], null);
  const out = await applyRestore(
    plan,
    async () => {
      throw new Error("spawn failed");
    },
    async () => {},
  );
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("spawn failed");
});

test("applyRestore pauses 0.5s between consecutive launches only", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", window_index: 0 }),
      fakeCandidate({ job_id: "b", window_index: 1 }),
      fakeCandidate({ job_id: "c", window_index: 2 }),
    ],
    null,
  );
  const sleeps: number[] = [];
  await applyRestore(
    plan,
    async () => ({ ok: true }),
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(sleeps).toEqual([500, 500]);
});

test("applyRestore emits no pause for a single launch", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "solo" })], null);
  const sleeps: number[] = [];
  await applyRestore(
    plan,
    async () => ({ ok: true }),
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(sleeps).toEqual([]);
});

test("applyRestore still pauses after a launch FAILURE (pacing outside try/catch)", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "fail", window_index: 0 }),
      fakeCandidate({ job_id: "ok", window_index: 1 }),
    ],
    null,
  );
  const sleeps: number[] = [];
  const out = await applyRestore(
    plan,
    async (_s, resumeTarget) =>
      resumeTarget === "fail" ? { ok: false, error: "boom" } : { ok: true },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(out.map((o) => o.kind)).toEqual(["failed", "restored"]);
  expect(sleeps).toEqual([500]);
});

test("renderOutcomes dry-run summary names would-restore", () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a" }), fakeCandidate({ job_id: "b" })],
    null,
  );
  const out = renderOutcomes(plan, false, 0);
  expect(out).toContain("would-restore=2");
  expect(out).not.toContain("restored=");
});

test("renderOutcomes apply summary names restored / failed", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "x" }),
      fakeCandidate({ job_id: "y" }),
      fakeCandidate({ job_id: "z" }),
    ],
    null,
  );
  const out = await applyRestore(
    plan,
    async (_s, resumeTarget) =>
      resumeTarget === "z" ? { ok: false, error: "nope" } : { ok: true },
    async () => {},
  );
  const rendered = renderOutcomes(out, true, 0);
  expect(rendered).toContain("restored=2");
  expect(rendered).toContain("failed=1");
  expect(rendered).toContain("FAILED z");
});

test("renderOutcomes labels use the candidate label, command targets the UUID", () => {
  const plan = planRestore(
    [
      fakeCandidate({
        job_id: "sess-aaaa",
        resume_target: "sess-aaaa",
        label: "epic-benchmark-monitor",
      }),
    ],
    null,
  );
  const out = renderOutcomes(plan, false, 0);
  expect(out).toContain("would restore epic-benchmark-monitor");
  expect(out).toContain(`claude --resume "sess-aaaa"`);
});

test("renderOutcomes surfaces / omits the idle-excluded note", () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  expect(renderOutcomes(plan, false, 3)).toContain(
    "3 crash-like candidate(s) excluded as idle",
  );
  expect(renderOutcomes(plan, false, 0)).not.toContain("excluded as idle");
});

test("countOutcomes tallies every kind incl. verified / launched-unverified", () => {
  const outcomes: AgentOutcome[] = [
    { kind: "restored", candidate: fakeCandidate({ job_id: "a" }) },
    { kind: "verified", candidate: fakeCandidate({ job_id: "v" }) },
    { kind: "failed", candidate: fakeCandidate({ job_id: "b" }), error: "x" },
    { kind: "would-restore", candidate: fakeCandidate({ job_id: "c" }) },
    {
      kind: "launched-unverified",
      candidate: fakeCandidate({ job_id: "u" }),
      reason: "pane alive, no evidence",
    },
    {
      kind: "not-resumable",
      candidate: fakeCandidate({ job_id: "d" }),
      reason: "no target",
    },
  ];
  expect(countOutcomes(outcomes)).toEqual({
    restored: 1,
    verified: 1,
    failed: 1,
    wouldRestore: 1,
    unverified: 1,
    notResumable: 1,
    preflightFailed: 0,
    unsupportedHarness: 0,
  });
});

// ---------------------------------------------------------------------------
// applyRestoreVerified — the per-tab durable, evidence-verified transaction
// ---------------------------------------------------------------------------

/** A recording intent sink + a base-intent builder for the verified-apply tests. */
function recordingIntent(): { writes: RestoreIntent[]; sink: IntentSink } {
  const writes: RestoreIntent[] = [];
  return { writes, sink: { write: (i) => writes.push({ ...i }) } };
}

function baseIntentFor(candidate: RestoreCandidate): RestoreIntent {
  return {
    schema_version: RESTORE_INTENT_SCHEMA_VERSION,
    generation_id: "gen-1",
    job_id: candidate.job_id,
    session_uuid: candidate.resume_target,
    harness: harnessOrClaude(candidate.harness),
    resume_target: candidate.resume_target,
    cwd: candidate.cwd ?? "",
    backend_exec_session_id: candidate.backend_exec_session_id,
    argv: ["keeper", "agent", "claude", "--resume", candidate.resume_target],
    rerun_command: "keeper tabs restore --apply --session work",
    attempt: 1,
    state: "planned",
    reason: "",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  };
}

test("applyRestoreVerified: a verified verdict → verified outcome + a verified intent carrying the identity", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => ({ ok: true }),
    verify: async () => ({
      verdict: "verified",
      identity: { pid: 5150, start_time: "darwin:v" },
    }),
    intent: sink,
    makeIntent: baseIntentFor,
    sleep: async () => {},
  });
  expect(out.map((o) => o.kind)).toEqual(["verified"]);
  // Write-before-launch then a terminal verified write, and the verified write
  // stamps the captured (pid, start_time) handle for the later no-op gate.
  expect(writes.map((w) => w.state)).toEqual(["launched", "verified"]);
  expect(writes.at(-1)?.verified_pid).toBe(5150);
  expect(writes.at(-1)?.verified_start_time).toBe("darwin:v");
});

test("applyRestoreVerified: later launches do not wait for an earlier verification timeout", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "a", window_index: 0 }),
      fakeCandidate({ job_id: "b", window_index: 1 }),
    ],
    null,
  );
  const { sink } = recordingIntent();
  const launched: string[] = [];
  let releaseFirst: ((verdict: AttachVerifyResult) => void) | undefined;
  const firstVerdict = new Promise<AttachVerifyResult>((resolve) => {
    releaseFirst = resolve;
  });
  let markSecondLaunched: (() => void) | undefined;
  const secondLaunched = new Promise<void>((resolve) => {
    markSecondLaunched = resolve;
  });

  const applying = applyRestoreVerified(plan, {
    ensureLaunched: async (_s, _r, _c, _h, jobId) => {
      launched.push(jobId);
      if (jobId === "b") {
        markSecondLaunched?.();
      }
      return { ok: true };
    },
    verify: async (candidate) =>
      candidate.job_id === "a"
        ? await firstVerdict
        : { verdict: "verified", identity: null },
    intent: sink,
    makeIntent: baseIntentFor,
    sleep: async () => {},
  });

  const launchedBeforeFirstSettled = await Promise.race([
    secondLaunched.then(() => true),
    Bun.sleep(50).then(() => false),
  ]);
  releaseFirst?.({ verdict: "launched-unverified", identity: null });
  const out = await applying;

  expect(launchedBeforeFirstSettled).toBe(true);
  expect(launched).toEqual(["a", "b"]);
  expect(out.map((o) => o.kind)).toEqual(["launched-unverified", "verified"]);
});

test("applyRestoreVerified: a launch failure → failed outcome, verify never runs", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  let verifyCalled = false;
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => ({ ok: false, error: "exit 3 NOOP" }),
    verify: async () => {
      verifyCalled = true;
      return { verdict: "verified", identity: null };
    },
    intent: sink,
    makeIntent: baseIntentFor,
    sleep: async () => {},
  });
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe("exit 3 NOOP");
  expect(verifyCalled).toBe(false);
  expect(writes.at(-1)?.state).toBe("failed");
  expect(writes.at(-1)?.reason).toBe("exit 3 NOOP");
});

test("applyRestoreVerified: died resume (verify failed) → failed + resurfacing intent", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => ({ ok: true }),
    verify: async () => ({ verdict: "failed", identity: null }),
    intent: sink,
    makeIntent: baseIntentFor,
    sleep: async () => {},
  });
  expect(out[0].kind).toBe("failed");
  expect((out[0] as { error: string }).error).toBe(VERIFY_FAILED_REASON);
  expect(writes.at(-1)?.state).toBe("failed");
});

test("applyRestoreVerified: no evidence + live pane → launched-unverified warn", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => ({ ok: true }),
    verify: async () => ({ verdict: "launched-unverified", identity: null }),
    intent: sink,
    makeIntent: baseIntentFor,
    sleep: async () => {},
  });
  expect(out[0].kind).toBe("launched-unverified");
  expect((out[0] as { reason: string }).reason).toBe(VERIFY_UNVERIFIED_REASON);
  expect(writes.at(-1)?.state).toBe("launched-unverified");
});

test("applyRestoreVerified: an already-live session no-ops (never launches)", async () => {
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  let launched = false;
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => {
      launched = true;
      return { ok: true };
    },
    verify: async () => ({ verdict: "failed", identity: null }),
    intent: sink,
    makeIntent: baseIntentFor,
    isLive: () => true,
    sleep: async () => {},
  });
  expect(out.map((o) => o.kind)).toEqual(["verified"]);
  // No launch, no intent churn — the existing verified marker is left untouched.
  expect(launched).toBe(false);
  expect(writes).toEqual([]);
});

test("applyRestoreVerified: isLive false re-attempts the tab (verified-then-died is never a permanent no-op)", async () => {
  // The re-run counterpart to the no-op test: a stored-verified tab whose identity
  // now probes dead (isLive false) is relaunched and re-verified, not masked.
  const plan = planRestore([fakeCandidate({ job_id: "a" })], null);
  const { writes, sink } = recordingIntent();
  let launched = false;
  const out = await applyRestoreVerified(plan, {
    ensureLaunched: async () => {
      launched = true;
      return { ok: true };
    },
    verify: async () => ({
      verdict: "verified",
      identity: { pid: 321, start_time: "darwin:new" },
    }),
    intent: sink,
    makeIntent: baseIntentFor,
    isLive: () => false,
    sleep: async () => {},
  });
  expect(launched).toBe(true);
  expect(out.map((o) => o.kind)).toEqual(["verified"]);
  expect(writes.map((w) => w.state)).toEqual(["launched", "verified"]);
});

test("applyRestoreVerified: hands verify the pre-launch floor + carries the launch id", async () => {
  const plan = planRestore(
    [fakeCandidate({ job_id: "a", resume_target: "sess-a", cwd: "/repo/a" })],
    null,
  );
  const { sink } = recordingIntent();
  const launchCalls: { resumeTarget: string; jobId: string }[] = [];
  const floors: number[] = [];
  await applyRestoreVerified(plan, {
    ensureLaunched: async (_s, resumeTarget, _c, _h, jobId) => {
      launchCalls.push({ resumeTarget, jobId });
      return { ok: true };
    },
    verify: async (_candidate, launchStartMs) => {
      floors.push(launchStartMs);
      return { verdict: "verified", identity: null };
    },
    intent: sink,
    makeIntent: baseIntentFor,
    now: () => 4242,
    sleep: async () => {},
  });
  expect(launchCalls).toEqual([{ resumeTarget: "sess-a", jobId: "a" }]);
  expect(floors).toEqual([4242]);
});

test("renderOutcomes apply summary counts verified as restored, notes unverified", () => {
  const outcomes: AgentOutcome[] = [
    { kind: "verified", candidate: fakeCandidate({ job_id: "v" }) },
    {
      kind: "launched-unverified",
      candidate: fakeCandidate({ job_id: "u" }),
      reason: "pane alive",
    },
  ];
  const rendered = renderOutcomes(outcomes, true, 0);
  expect(rendered).toContain("VERIFIED");
  expect(rendered).toContain("UNVERIFIED");
  expect(rendered).toContain("# summary: restored=1 failed=0 unverified=1");
});

// ---------------------------------------------------------------------------
// disk-anchored resume — planRestore / renderSnapshotScript consume the resolver
// ---------------------------------------------------------------------------

test("renderSnapshotScript emits the RESOLVED cd, never the recorded one", () => {
  const RECORDED = "/Users/mike/old-worktree";
  const RESOLVED = "/Users/mike/code/keeper";
  const resolver: ResumeResolver = () => ({ kind: "resolved", cwd: RESOLVED });
  const script = renderSnapshotScriptRaw(
    [
      fakeCandidate({
        job_id: "j",
        resume_target: "j",
        label: "drifted",
        cwd: RECORDED,
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
      resolver,
    },
  );
  expect(script).toContain(`cd '${RESOLVED}' && `);
  expect(script).not.toContain(`cd '${RECORDED}'`);
});

test("renderSnapshotScript: an unresolvable claude candidate is a comment + fix, never a --resume line", () => {
  const resolver: ResumeResolver = () => ({
    kind: "preflight-failed",
    reason: "no claude transcript on disk for session j",
    found: ["/proj/a", "/proj/b"],
    fixCommand: 'cd /proj/a && claude --resume "j"',
  });
  const script = renderSnapshotScriptRaw(
    [
      fakeCandidate({
        job_id: "j",
        resume_target: "j",
        label: "gone",
        cwd: "/stale",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
      resolver,
    },
  );
  expect(script).toContain(
    "# preflight-failed: gone (no claude transcript on disk for session j) [found: /proj/a, /proj/b]",
  );
  expect(script).toContain('# fix: cd /proj/a && claude --resume "j"');
  // No doomed launch: the resume argv never reaches an executable line.
  for (const line of executableRemainders(script)) {
    expect(line.includes("--resume")).toBe(false);
  }
  expect(script).toContain("windows=0");
});

test("renderSnapshotScript: a non-claude target with no artifact is a not-resumable comment", () => {
  const resolver: ResumeResolver = () => ({
    kind: "not-resumable",
    reason:
      "pi session p has no on-disk artifact under /home/.pi/agent/sessions",
  });
  const script = renderSnapshotScriptRaw(
    [
      fakeCandidate({
        job_id: "pj",
        harness: "pi",
        resume_target: "p",
        label: "pi tab",
        cwd: "/repo",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
      resolver,
    },
  );
  expect(script).toContain(
    "# not-resumable: pi tab (pi session p has no on-disk artifact under /home/.pi/agent/sessions)",
  );
  for (const line of executableRemainders(script)) {
    expect(line.includes("'--session'")).toBe(false);
  }
});

test("planRestore threads resolver verdicts into typed outcomes (resolved cwd wins)", () => {
  const RESOLVED = "/Users/mike/code/keeper";
  const resolver: ResumeResolver = (c) => {
    if (c.job_id === "ok") return { kind: "resolved", cwd: RESOLVED };
    if (c.job_id === "pf")
      return {
        kind: "preflight-failed",
        reason: "zero-match",
        found: [],
        fixCommand: "# not resumable",
      };
    return { kind: "not-resumable", reason: "no artifact" };
  };
  const plan = planRestoreRaw(
    [
      fakeCandidate({ job_id: "ok", resume_target: "ok", cwd: "/stale" }),
      fakeCandidate({ job_id: "pf", resume_target: "pf", cwd: "/stale" }),
      fakeCandidate({
        job_id: "nr",
        harness: "pi",
        resume_target: "pi-missing",
        cwd: "/repo",
      }),
    ],
    null,
    resolver,
  );
  expect(plan.map((p) => p.kind)).toEqual([
    "would-restore",
    "preflight-failed",
    "not-resumable",
  ]);
  // The would-restore candidate carries the RESOLVED cwd (recorded demoted).
  expect(plan[0].candidate.cwd).toBe(RESOLVED);
  expect((plan[1] as { fixCommand: string }).fixCommand).toBe(
    "# not resumable",
  );
});

test("planRestore skips and surfaces an unregistered harness without dropping healthy candidates", () => {
  let resolverCalls = 0;
  const resolver: ResumeResolver = () => {
    resolverCalls++;
    return { kind: "resumable" };
  };
  const plan = planRestoreRaw(
    [
      fakeCandidate({ job_id: "ok", resume_target: "ok" }),
      fakeCandidate({
        job_id: "retired",
        harness: "hermes",
        resume_target: "legacy-target",
      }),
    ],
    null,
    resolver,
  );
  expect(plan.map((p) => p.kind)).toEqual([
    "would-restore",
    "unsupported-harness",
  ]);
  expect((plan[1] as { reason: string }).reason).toBe(
    "unknown harness 'hermes'",
  );
  expect(resolverCalls).toBe(1);
});

test("applyRestore skips an unregistered harness and still launches healthy entries", async () => {
  let launches = 0;
  const plan: AgentOutcome[] = [
    {
      kind: "would-restore",
      candidate: fakeCandidate({ job_id: "ok", resume_target: "ok" }),
    },
    {
      kind: "would-restore",
      candidate: fakeCandidate({
        job_id: "retired",
        harness: "codex",
        resume_target: "legacy-target",
      }),
    },
  ];
  const out = await applyRestore(plan, async () => {
    launches++;
    return { ok: true };
  });
  expect(out.map((o) => o.kind)).toEqual(["restored", "unsupported-harness"]);
  expect(launches).toBe(1);
});

test("renderOutcomes surfaces the preflight-failed stanza + summary note", () => {
  const plan: AgentOutcome[] = [
    {
      kind: "would-restore",
      candidate: fakeCandidate({
        job_id: "ok",
        resume_target: "ok",
        label: "good",
        cwd: "/repo",
      }),
    },
    {
      kind: "preflight-failed",
      candidate: fakeCandidate({
        job_id: "pf",
        resume_target: "pf",
        label: "bad",
        cwd: "/stale",
      }),
      reason: "zero-match",
      found: ["/proj/x"],
      fixCommand: 'cd /proj/x && claude --resume "pf"',
    },
  ];
  const out = renderOutcomes(plan, false, 0);
  expect(out).toContain("PREFLIGHT-FAILED bad: zero-match [found: /proj/x]");
  expect(out).toContain('# fix: cd /proj/x && claude --resume "pf"');
  expect(out).toContain("would-restore=1 preflight-failed=1");
});

// ---------------------------------------------------------------------------
// selectRestoreGeneration — the recency-first auto-pick (the epic keystone)
// ---------------------------------------------------------------------------

test("selectRestoreGeneration restores the 9-pane generation, NEVER the 1-pane skeleton", () => {
  // The recorded incident: a rich 9-pane dead generation shadowed by a NEWER
  // 1-pane skeleton generation. Newest-first order, skeleton flagged degenerate.
  const richCandidates = Array.from({ length: 9 }, (_, i) =>
    fakeCandidate({ job_id: `rich-${i}`, window_index: i }),
  );
  const eNriched: EnrichedGeneration[] = [
    enriched(
      gen({
        generation_id: "gen-skeleton",
        last_event_id: 200,
        max_pane_count: 1,
        degenerate: true,
      }),
      [fakeCandidate({ job_id: "skel" })],
    ),
    enriched(
      gen({
        generation_id: "gen-rich",
        last_event_id: 100,
        max_pane_count: 9,
      }),
      richCandidates,
    ),
  ];
  const sel = selectRestoreGeneration(eNriched);
  expect(sel.pickedGeneration?.generation_id).toBe("gen-rich");
  expect(sel.candidates).toHaveLength(9);
  expect(sel.ambiguous).toBe(false);
});

test("selectRestoreGeneration picks the freshest but flags ambiguous when an older generation is substantially richer", () => {
  const eNriched: EnrichedGeneration[] = [
    enriched(gen({ generation_id: "gen-fresh", last_event_id: 200 }), [
      fakeCandidate({ job_id: "f1" }),
      fakeCandidate({ job_id: "f2" }),
    ]),
    enriched(gen({ generation_id: "gen-rich", last_event_id: 100 }), [
      fakeCandidate({ job_id: "r1" }),
      fakeCandidate({ job_id: "r2" }),
      fakeCandidate({ job_id: "r3" }),
      fakeCandidate({ job_id: "r4" }),
      fakeCandidate({ job_id: "r5" }),
    ]),
  ];
  const sel = selectRestoreGeneration(eNriched);
  // Recency-first: the freshest (2 restorable) is picked, NOT the richer older one.
  expect(sel.pickedGeneration?.generation_id).toBe("gen-fresh");
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["f1", "f2"]);
  // ...but the substantially-richer older cohort (5 vs 2) contests the pick.
  expect(sel.ambiguous).toBe(true);
  // Both eligible generations are offered in the picker menu.
  expect(sel.eligible.map((g) => g.generation_id).sort()).toEqual([
    "gen-fresh",
    "gen-rich",
  ]);
});

test("selectRestoreGeneration does NOT flag ambiguous for a marginally-richer older generation", () => {
  // gen-fresh (newest) has 2 restorable; gen-close has 3 — richer, but below the
  // factor+gap threshold. Recency-first takes the freshest silently.
  const eNriched: EnrichedGeneration[] = [
    enriched(gen({ generation_id: "gen-fresh", last_event_id: 200 }), [
      fakeCandidate({ job_id: "f1" }),
      fakeCandidate({ job_id: "f2" }),
    ]),
    enriched(gen({ generation_id: "gen-close", last_event_id: 100 }), [
      fakeCandidate({ job_id: "c1" }),
      fakeCandidate({ job_id: "c2" }),
      fakeCandidate({ job_id: "c3" }),
    ]),
  ];
  const sel = selectRestoreGeneration(eNriched);
  expect(sel.pickedGeneration?.generation_id).toBe("gen-fresh");
  expect(sel.ambiguous).toBe(false);
});

test("selectRestoreGeneration --generation targets a specific generation, no ambiguity", () => {
  const eNriched: EnrichedGeneration[] = [
    enriched(gen({ generation_id: "gen-fresh", last_event_id: 200 }), [
      fakeCandidate({ job_id: "f1" }),
      fakeCandidate({ job_id: "f2" }),
    ]),
    enriched(gen({ generation_id: "gen-rich", last_event_id: 100 }), [
      fakeCandidate({ job_id: "r1" }),
      fakeCandidate({ job_id: "r2" }),
      fakeCandidate({ job_id: "r3" }),
    ]),
  ];
  const sel = selectRestoreGeneration(eNriched, { generationId: "gen-fresh" });
  expect(sel.pickedGeneration?.generation_id).toBe("gen-fresh");
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["f1", "f2"]);
  expect(sel.ambiguous).toBe(false);
});

test("selectRestoreGeneration --generation for an unknown id sets unknownGeneration", () => {
  const sel = selectRestoreGeneration(
    [
      enriched(gen({ generation_id: "gen-a" }), [
        fakeCandidate({ job_id: "a" }),
      ]),
    ],
    { generationId: "gen-nope" },
  );
  expect(sel.unknownGeneration).toBe("gen-nope");
  expect(sel.candidates).toEqual([]);
  expect(sel.pickedGeneration).toBeNull();
});

test("selectRestoreGeneration excludes degenerate + current + zero-restorable from the auto-pick", () => {
  const eNriched: EnrichedGeneration[] = [
    enriched(
      gen({
        generation_id: "gen-current",
        last_event_id: 300,
        is_current: true,
      }),
      [fakeCandidate({ job_id: "c1" })],
    ),
    enriched(
      gen({
        generation_id: "gen-skeleton",
        last_event_id: 250,
        degenerate: true,
      }),
      [fakeCandidate({ job_id: "s1" })],
    ),
    enriched(gen({ generation_id: "gen-empty", last_event_id: 200 }), []),
    enriched(gen({ generation_id: "gen-good", last_event_id: 100 }), [
      fakeCandidate({ job_id: "g1" }),
    ]),
  ];
  const sel = selectRestoreGeneration(eNriched);
  expect(sel.pickedGeneration?.generation_id).toBe("gen-good");
  expect(sel.eligible.map((g) => g.generation_id)).toEqual(["gen-good"]);
});

test("selectRestoreGeneration excludes generations idle past the cutoff", () => {
  const stale = RECENT - 30 * 24 * 60 * 60; // ~30 days ago
  const sel = selectRestoreGeneration([
    enriched(gen({ generation_id: "gen-stale", last_ts: stale }), [
      fakeCandidate({ job_id: "old" }),
    ]),
  ]);
  expect(sel.pickedGeneration).toBeNull();
  expect(sel.candidates).toEqual([]);
});

// ---------------------------------------------------------------------------
// load* readers over a seeded keeper.db (daemon-down, no socket)
// ---------------------------------------------------------------------------

test("bounded generation probe keeps timeout/signal inconclusive instead of marking the live generation dead", () => {
  expect(() =>
    generationFromBoundedProbe({
      success: false,
      exitCode: null,
      stdout: Buffer.from(""),
      exitedDueToTimeout: true,
    }),
  ).toThrow("timed out or was signal-killed");
  expect(() =>
    generationFromBoundedProbe({
      success: false,
      exitCode: null,
      stdout: Buffer.from(""),
    }),
  ).toThrow("timed out or was signal-killed");
  expect(
    generationFromBoundedProbe({
      success: false,
      exitCode: 1,
      stdout: Buffer.from(""),
    }),
  ).toBeNull();
  expect(
    generationFromBoundedProbe({
      success: true,
      exitCode: 0,
      stdout: Buffer.from("4242:777\n"),
    }),
  ).toBe("4242:777");
});

test("loadRestorePlan: topology-anchored — offers ONLY the dying-gen snapshot panes", () => {
  seedJob(kdb.db, {
    job_id: "live-a",
    title: "alpha",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "live-b",
    title: "beta",
    window_index: 1,
    backend_exec_session_id: "work",
  });
  seedTmuxTopologySnapshot(kdb.db, 900, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "live-a" },
    { pane_id: "%2", session_name: "work", window_index: 1, job_id: "live-b" },
  ]);
  kdb.db.close();

  const sel = loadRestorePlan(dbPath, { probeNow: () => "gen-now" });
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["live-a", "live-b"]);
  expect(sel.pickedGeneration?.generation_id).toBe("gen-dead");
  expect(sel.fallbackNote).toBeUndefined();
});

test("loadRestorePlan: no restorable topology ⇒ labeled killed-cohort fallback", () => {
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "killed-cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "retired-cohort",
    close_kind: "server_gone",
    harness: "hermes",
    resume_target: "legacy-target",
    window_index: 1,
    last_event_id: 151,
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const sel = loadRestorePlan(dbPath, { probeNow: () => "gen-now" });
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["killed-cohort"]);
  expect(sel.pickedGeneration).toBeNull();
  expect(sel.fallbackNote).toBeDefined();
  expect(sel.unregisteredHarnessSkipCount).toBe(1);
});

test("loadRestorePlan: --generation targets one generation's panes", () => {
  seedJob(kdb.db, {
    job_id: "a",
    title: "alpha",
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "b",
    title: "beta",
    backend_exec_session_id: "work",
  });
  seedTmuxTopologySnapshot(kdb.db, 800, "gen-old", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "a" },
  ]);
  seedTmuxTopologySnapshot(kdb.db, 900, "gen-new", [
    { pane_id: "%2", session_name: "work", window_index: 0, job_id: "b" },
  ]);
  kdb.db.close();

  const sel = loadRestorePlan(dbPath, {
    probeNow: () => "gen-now",
    generationId: "gen-old",
  });
  expect(sel.pickedGeneration?.generation_id).toBe("gen-old");
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["a"]);
});

test("loadCurrentSetForDump excludes reconciler-managed workers + counts them; --include-managed keeps them", () => {
  seedJob(kdb.db, {
    job_id: "human-1",
    state: "working",
    title: "human",
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "worker-1",
    state: "working",
    plan_verb: "work",
    backend_exec_session_id: "autopilot",
  });
  seedJob(kdb.db, {
    job_id: "retired-1",
    state: "working",
    harness: "codex",
    resume_target: "legacy-target",
    backend_exec_session_id: "work",
  });
  kdb.db.close();

  const excluded = loadCurrentSetForDump(dbPath);
  expect(excluded.candidates.map((c) => c.job_id)).toEqual(["human-1"]);
  expect(excluded.excludedManagedCount).toBe(1);
  expect(excluded.unregisteredHarnessSkipCount).toBe(1);

  const included = loadCurrentSetForDump(dbPath, { includeManaged: true });
  expect(included.candidates.map((c) => c.job_id).sort()).toEqual([
    "human-1",
    "worker-1",
  ]);
  expect(included.excludedManagedCount).toBe(0);
  expect(included.unregisteredHarnessSkipCount).toBe(1);
});

test("loadGenerationList returns ranked generations (with sample labels) + the current set", () => {
  seedJob(kdb.db, {
    job_id: "live-a",
    state: "working",
    title: "alpha",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "dead-a",
    title: "gamma",
    window_index: 0,
    backend_exec_session_id: "work",
  });
  seedTmuxTopologySnapshot(kdb.db, 900, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "dead-a" },
  ]);
  kdb.db.close();

  const payload = loadGenerationList(dbPath, { probeNow: () => "gen-now" });
  const dead = payload.generations.find((g) => g.generation_id === "gen-dead");
  expect(dead).toBeDefined();
  expect(dead?.sample_labels).toContain("gamma");
  expect(payload.current.map((c) => c.job_id)).toContain("live-a");
});

// ---------------------------------------------------------------------------
// autopilot gate (ported)
// ---------------------------------------------------------------------------

test("autopilotGateDecision matrix", () => {
  expect(autopilotGateDecision(true, false)).toBe("proceed");
  expect(autopilotGateDecision(true, true)).toBe("proceed");
  expect(autopilotGateDecision(false, false)).toBe("blocked");
  expect(autopilotGateDecision(false, true)).toBe("forced");
  expect(autopilotGateDecision(false, false, false)).toBe("proceed");
});

const outcomeForSession = (session: string): AgentOutcome => ({
  kind: "would-restore",
  candidate: fakeCandidate({
    job_id: `job-${session}`,
    backend_exec_session_id: session,
  }),
});

test("restorePlanTouchesManagedSession: only the managed backend session trips the gate", () => {
  expect(restorePlanTouchesManagedSession([outcomeForSession("work")])).toBe(
    false,
  );
  expect(
    restorePlanTouchesManagedSession([outcomeForSession("autopilot")]),
  ).toBe(true);
});

test("readAutopilotPaused reads folded state (0 unpaused, 1 paused, absent permissive)", () => {
  seedAutopilotPaused(kdb.db, 0);
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(false);
});

test("readAutopilotPaused: paused=1 reads PAUSED", () => {
  seedAutopilotPaused(kdb.db, 1);
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(true);
});

test("readAutopilotPaused: absent singleton reads PAUSED (permissive)", () => {
  kdb.db.close();
  expect(readAutopilotPaused(dbPath)).toBe(true);
});

// ---------------------------------------------------------------------------
// parseTabsArgv — verb routing
// ---------------------------------------------------------------------------

test("parseTabsArgv routes list / restore / dump with their flags", () => {
  expect(parseTabsArgv(["list"])).toEqual({ kind: "list", db: null });
  expect(parseTabsArgv(["list", "--db", "/x/keeper.db"])).toEqual({
    kind: "list",
    db: "/x/keeper.db",
  });
  expect(
    parseTabsArgv([
      "restore",
      "--apply",
      "--generation",
      "gen-7",
      "--session",
      "work",
      "--allow-empty",
      "--force",
    ]),
  ).toEqual({
    kind: "restore",
    apply: true,
    generation: "gen-7",
    session: "work",
    allowEmpty: true,
    force: true,
    db: null,
  });
  expect(
    parseTabsArgv(["dump", "--include-managed", "--session", "work"]),
  ).toEqual({
    kind: "dump",
    includeManaged: true,
    session: "work",
    db: null,
  });
});

test("parseTabsArgv: help + unknown verb signals", () => {
  expect(parseTabsArgv([])).toEqual({ kind: "help", verb: "" });
  expect(parseTabsArgv(["--help"])).toEqual({ kind: "help", verb: "" });
  expect(parseTabsArgv(["restore", "--help"])).toEqual({
    kind: "help",
    verb: "restore",
  });
  const bogus = parseTabsArgv(["bogus"]);
  expect(bogus.kind).toBe("usage");
  const badflag = parseTabsArgv(["list", "--nope"]);
  expect(badflag.kind).toBe("usage");
});

test("parseTabsArgv: --agent-help routes to the operator runbook (pure)", () => {
  // Top-level runbook request, honored anywhere and never per-verb — so no
  // keeper.db open, no restore side effect.
  expect(parseTabsArgv(["--agent-help"])).toEqual({ kind: "agent-help" });
  expect(parseTabsArgv(["restore", "--agent-help"])).toEqual({
    kind: "agent-help",
  });
  // Content assertion (catches an empty stub): names its primary verb form.
  expect(TABS_AGENT_HELP).toContain("operator runbook");
  expect(TABS_AGENT_HELP).toContain("keeper tabs restore");
});

// ---------------------------------------------------------------------------
// classifyRestore — the exit-code matrix
// ---------------------------------------------------------------------------

const baseClassify = {
  ambiguous: false,
  hasExplicitGeneration: false,
  tty: false,
  apply: false,
  allowEmpty: false,
  candidateCount: 2,
  gate: "proceed" as const,
};

test("classifyRestore: non-TTY ambiguous refuses; TTY ambiguous escalates to the picker", () => {
  expect(
    classifyRestore({ ...baseClassify, ambiguous: true, tty: false }).kind,
  ).toBe("refuse-ambiguous");
  expect(
    classifyRestore({ ...baseClassify, ambiguous: true, tty: true }).kind,
  ).toBe("picker");
});

test("classifyRestore: an explicit --generation suppresses the ambiguity escalation", () => {
  expect(
    classifyRestore({
      ...baseClassify,
      ambiguous: true,
      tty: false,
      hasExplicitGeneration: true,
    }).kind,
  ).toBe("dry-run");
});

test("classifyRestore: dry-run by default", () => {
  expect(classifyRestore(baseClassify).kind).toBe("dry-run");
});

test("classifyRestore: --apply asserts the autopilot gate first (blocked even with allow-empty/zero)", () => {
  expect(
    classifyRestore({
      ...baseClassify,
      apply: true,
      gate: "blocked",
      allowEmpty: true,
      candidateCount: 0,
    }).kind,
  ).toBe("gate-blocked");
});

test("classifyRestore: --apply zero candidates fails unless --allow-empty", () => {
  expect(
    classifyRestore({ ...baseClassify, apply: true, candidateCount: 0 }).kind,
  ).toBe("zero-candidates");
  // --allow-empty proceeds to a no-op apply (no confirm even on a TTY).
  expect(
    classifyRestore({
      ...baseClassify,
      apply: true,
      candidateCount: 0,
      allowEmpty: true,
      tty: true,
    }).kind,
  ).toBe("apply");
});

test("classifyRestore: --apply confirms on a TTY, applies directly off a TTY", () => {
  expect(
    classifyRestore({ ...baseClassify, apply: true, tty: true }).kind,
  ).toBe("confirm-apply");
  expect(
    classifyRestore({ ...baseClassify, apply: true, tty: false }).kind,
  ).toBe("apply");
});

test("classifyRestore: --apply forced gate still applies (the caller warns)", () => {
  expect(
    classifyRestore({ ...baseClassify, apply: true, gate: "forced" }).kind,
  ).toBe("apply");
});

// ---------------------------------------------------------------------------
// parsePickerChoice / renderers
// ---------------------------------------------------------------------------

test("parsePickerChoice maps a 1-based index in range, else aborts", () => {
  expect(parsePickerChoice("1", 3)).toBe(0);
  expect(parsePickerChoice("3", 3)).toBe(2);
  expect(parsePickerChoice(" 2 ", 3)).toBe(1);
  expect(parsePickerChoice("", 3)).toBeNull();
  expect(parsePickerChoice("q", 3)).toBeNull();
  expect(parsePickerChoice("0", 3)).toBeNull();
  expect(parsePickerChoice("4", 3)).toBeNull();
  expect(parsePickerChoice("x", 3)).toBeNull();
});

test("formatAge buckets seconds/minutes/hours/days", () => {
  expect(formatAge(5)).toBe("5s");
  expect(formatAge(90)).toBe("1m");
  expect(formatAge(3 * 3600)).toBe("3h");
  expect(formatAge(2 * 86400)).toBe("2d");
  expect(formatAge(-10)).toBe("0s");
});

test("formatGenerationMenu numbers each generation with its restorable count + flags", () => {
  const nowSecs = RECENT + 120;
  const menu = formatGenerationMenu(
    [
      gen({ generation_id: "gen-a", restorable: 5, last_ts: RECENT }),
      gen({
        generation_id: "gen-b",
        restorable: 1,
        last_ts: RECENT,
        degenerate: true,
      }),
    ],
    nowSecs,
  );
  expect(menu).toContain("[1] gen gen-a — 5 agent(s)");
  expect(menu).toContain("[2] gen gen-b — 1 agent(s)");
  expect(menu).toContain("[skeleton]");
});

test("formatRestoreConfirmSummary shows the generation context + candidate labels", () => {
  const selection: RestoreSelection = {
    candidates: [],
    pickedGeneration: gen({
      generation_id: "gen-x",
      restorable: 2,
      max_pane_count: 3,
      last_ts: RECENT,
    }),
    eligible: [],
    ambiguous: false,
  };
  const out = formatRestoreConfirmSummary(
    selection,
    ["alpha", "beta"],
    RECENT + 60,
  );
  expect(out).toContain("generation gen-x");
  expect(out).toContain("- alpha");
  expect(out).toContain("- beta");
});

test("formatRestoreConfirmSummary reports the killed-cohort fallback when there is no picked generation", () => {
  const selection: RestoreSelection = {
    candidates: [],
    pickedGeneration: null,
    eligible: [],
    ambiguous: false,
  };
  const out = formatRestoreConfirmSummary(selection, ["only-one"]);
  expect(out).toContain("killed-cohort fallback");
  expect(out).toContain("- only-one");
});

// Exit-code constants are published (guards against an accidental renumber into
// the usage / await-owned range).
test("tabs restore exit codes sit outside the 0–5 core/await range", () => {
  expect(TABS_EXIT_ZERO_CANDIDATES).toBe(7);
  expect(TABS_EXIT_PARTIAL_FAILURE).toBe(8);
});

// ---------------------------------------------------------------------------
// Resume-target repair — the rotted-pi report (`keeper tabs repair`) + the
// daemon-side back-fill producer pass (driven unit-level, no daemon boot).
// ---------------------------------------------------------------------------

const ROT_TARGET = "aaaaaaaa-0000-0000-0000-000000000000";
const PLAUSIBLE_UUID = "11111111-2222-3333-4444-555555555555";
const PLAUSIBLE_UUID_2 = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const PI_CWD = "/repo/pi";

/** Mirror of the pi transcript-watch producer's cwd → sessions-subdir encoding. */
function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

/** Build a real pi session filename `<iso-ts>_<uuid>.jsonl` for a given instant. */
function piFileName(uuid: string, ms: number): string {
  return `${new Date(ms).toISOString().replace(/[:.]/g, "-")}_${uuid}.jsonl`;
}

/** Write a pi session file under the fixture store's cwd project dir. */
function writePiSession(
  piRoot: string,
  cwd: string,
  uuid: string,
  createdAtMs: number,
): void {
  const dir = join(piRoot, "sessions", encodePiCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, piFileName(uuid, createdAtMs)), "{}\n");
}

/** Insert a raw event row (all columns default NULL; overrides win) so the
 *  reducer folds it exactly as MAIN would. */
function insertRawEvent(
  db: Database,
  overrides: {
    hook_event: string;
    session_id: string;
    ts: number;
    cwd?: string | null;
    harness?: string | null;
    resume_target?: string | null;
  },
): void {
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id, mutation_path, worktree, harness, resume_target
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.ts,
      overrides.session_id,
      4242,
      overrides.hook_event,
      overrides.hook_event,
      null,
      null,
      overrides.cwd ?? null,
      null,
      null,
      null,
      null,
      "{}",
      null,
      overrides.session_id,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      overrides.harness ?? null,
      overrides.resume_target ?? null,
    ],
  );
}

function drainAll(db: Database): void {
  let n: number;
  do {
    n = drain(db);
  } while (n > 0);
}

/** Seed a tracked pi job (SessionStart) carrying a recorded resume target and fold
 *  it into a `jobs` row (state `stopped`, harness `pi`). */
function seedPiJob(
  db: Database,
  jobId: string,
  cwd: string,
  resumeTarget: string,
  ts: number,
): void {
  insertRawEvent(db, {
    hook_event: "SessionStart",
    session_id: jobId,
    ts,
    cwd,
    harness: "pi",
    resume_target: resumeTarget,
  });
  drainAll(db);
}

function resumeTargetOf(db: Database, jobId: string): string | null {
  const row = db
    .query("SELECT resume_target FROM jobs WHERE job_id = ?")
    .get(jobId) as { resume_target: string | null } | null;
  return row?.resume_target ?? null;
}

/** The fixture pi store + an isolated home (no real `~/.pi`) for a repair run. */
function repairEnv(): {
  homeDir: string;
  env: Record<string, string | undefined>;
  piRoot: string;
} {
  const piRoot = join(tmpDir, "pi");
  return {
    homeDir: join(tmpDir, "home"),
    env: { PI_CODING_AGENT_DIR: piRoot },
    piRoot,
  };
}

test("parsePiSessionFileName extracts the uuid + session-start instant", () => {
  const parsed = parsePiSessionFileName(
    "2026-06-27T02-31-45-766Z_019f06eb-3566-7a6b-a149-f5b6996e30e5.jsonl",
  );
  expect(parsed).toEqual({
    uuid: "019f06eb-3566-7a6b-a149-f5b6996e30e5",
    createdAtMs: Date.parse("2026-06-27T02:31:45.766Z"),
  });
  // A non-session filename (no uuid / wrong extension) is never a candidate.
  expect(parsePiSessionFileName("index.jsonl")).toBeNull();
  expect(parsePiSessionFileName("2026-06-27_notauuid.jsonl")).toBeNull();
});

test("repair reports the sole plausible pi session, excluding the distant one", () => {
  const { homeDir, env, piRoot } = repairEnv();
  seedPiJob(kdb.db, "pi-job-1", PI_CWD, ROT_TARGET, RECENT);
  // One session at job start (plausible) and one two days earlier (implausible).
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID, RECENT * 1000);
  writePiSession(
    piRoot,
    PI_CWD,
    PLAUSIBLE_UUID_2,
    RECENT * 1000 - 2 * 86400_000,
  );

  const proposals = loadRepairProposals(dbPath, { homeDir, env });
  expect(proposals).toHaveLength(1);
  const p = proposals[0];
  expect(p?.kind).toBe("resolved");
  expect(p?.oldTarget).toBe(ROT_TARGET);
  if (p?.kind === "resolved") {
    expect(p.newTarget).toBe(PLAUSIBLE_UUID);
  }
  expect(p?.note).toContain("from job start");
});

test("repair surfaces two plausible candidates as ambiguous, never resolved", () => {
  const { homeDir, env, piRoot } = repairEnv();
  seedPiJob(kdb.db, "pi-job-1", PI_CWD, ROT_TARGET, RECENT);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID, RECENT * 1000);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID_2, RECENT * 1000);

  const proposals = loadRepairProposals(dbPath, { homeDir, env });
  expect(proposals).toHaveLength(1);
  const p = proposals[0];
  expect(p?.kind).toBe("ambiguous");
  if (p?.kind === "ambiguous") {
    expect(p.candidates.map((c) => c.uuid).sort()).toEqual(
      [PLAUSIBLE_UUID, PLAUSIBLE_UUID_2].sort(),
    );
  }
});

test("repair never reports a pi row whose recorded target still exists on disk", () => {
  const { homeDir, env, piRoot } = repairEnv();
  // The recorded target itself is on disk — not rotted, so nothing to repair.
  seedPiJob(kdb.db, "pi-job-1", PI_CWD, PLAUSIBLE_UUID, RECENT);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID, RECENT * 1000);

  expect(loadRepairProposals(dbPath, { homeDir, env })).toEqual([]);
});

test("the producer pass applies a single-candidate re-pin and the projection re-reads repaired", () => {
  const { homeDir, env, piRoot } = repairEnv();
  seedPiJob(kdb.db, "pi-job-1", PI_CWD, ROT_TARGET, RECENT);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID, RECENT * 1000);
  expect(resumeTargetOf(kdb.db, "pi-job-1")).toBe(ROT_TARGET);

  const now = Date.now() / 1000;
  const repairs = resolvePiResumeRepairs(
    kdb.db,
    homeDir,
    env,
    now,
    PI_RESUME_REPAIR_RECENT_WINDOW_SEC,
  );
  expect(repairs).toEqual([
    { jobId: "pi-job-1", oldTarget: ROT_TARGET, newTarget: PLAUSIBLE_UUID },
  ]);

  // Feed the producer's output as MAIN would: a ResumeTargetResolved event whose
  // fold overwrites jobs.resume_target without touching lifecycle state.
  insertRawEvent(kdb.db, {
    hook_event: "ResumeTargetResolved",
    session_id: "pi-job-1",
    ts: now + 1,
    resume_target: PLAUSIBLE_UUID,
  });
  drainAll(kdb.db);
  expect(resumeTargetOf(kdb.db, "pi-job-1")).toBe(PLAUSIBLE_UUID);
  // The rot is healed: the repaired target now exists on disk, so the report is
  // clean and `keeper tabs dump` would emit an on-disk-backed resume line.
  expect(loadRepairProposals(dbPath, { homeDir, env })).toEqual([]);
});

test("the producer pass mints nothing for an ambiguous two-candidate job", () => {
  const { homeDir, env, piRoot } = repairEnv();
  seedPiJob(kdb.db, "pi-job-1", PI_CWD, ROT_TARGET, RECENT);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID, RECENT * 1000);
  writePiSession(piRoot, PI_CWD, PLAUSIBLE_UUID_2, RECENT * 1000);

  const repairs = resolvePiResumeRepairs(
    kdb.db,
    homeDir,
    env,
    Date.now() / 1000,
    PI_RESUME_REPAIR_RECENT_WINDOW_SEC,
  );
  expect(repairs).toEqual([]);
  expect(resumeTargetOf(kdb.db, "pi-job-1")).toBe(ROT_TARGET);
});
