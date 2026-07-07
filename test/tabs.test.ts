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
 *  - selection: selectRestoreGeneration — the richness-ranked auto-pick that
 *    restores the 9-pane generation over the 1-pane skeleton, the ambiguity flag,
 *    and explicit --generation targeting.
 *  - CLI: parseTabsArgv routing, classifyRestore (refuse/zero/gate/partial/
 *    allow-empty), parsePickerChoice, and the table/summary renderers.
 *
 * `main()`'s I/O wiring (process.exit, TTY readline) is NOT driven here — the same
 * shape every other one-shot CLI test uses.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import type {
  EnrichedGeneration,
  GenerationSummary,
  RestoreCandidate,
} from "../src/restore-set";
import {
  type AgentOutcome,
  applyRestore,
  autopilotGateDecision,
  countOutcomes,
  loadCurrentSetForDump,
  loadGenerationList,
  loadRestorePlan,
  planRestore,
  type RestoreSelection,
  readAutopilotPaused,
  renderOutcomes,
  renderSnapshotScript,
  restorePlanTouchesManagedSession,
  selectRestoreGeneration,
} from "../src/tabs-core";
import { freshDbFile } from "./helpers/template-db";

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
}

function seedJob(db: Database, j: SeedJob): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, title, cwd, close_kind,
       window_index, backend_exec_session_id, plan_verb, last_event_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return { summary: { ...summary, restorable: candidates.length }, candidates };
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
  expect(script).not.toContain("j1");
  expect(script).not.toContain("j2");
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
      "'--x-tmux-env' 'KEEPER_ESCALATION_ROLE=' " +
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
  const calls: { session: string; resumeTarget: string; cwd: string }[] = [];
  const out = await applyRestore(
    plan,
    async (session, resumeTarget, cwd) => {
      calls.push({ session, resumeTarget, cwd });
      return { ok: true };
    },
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual(["restored", "restored"]);
  expect(calls[0]).toEqual({
    session: "work",
    resumeTarget: "a-name",
    cwd: "/repo/a",
  });
  expect(calls[1].resumeTarget).toBe("b-name");
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

test("countOutcomes tallies restored / failed / would-restore / not-resumable", () => {
  const outcomes: AgentOutcome[] = [
    { kind: "restored", candidate: fakeCandidate({ job_id: "a" }) },
    { kind: "failed", candidate: fakeCandidate({ job_id: "b" }), error: "x" },
    { kind: "would-restore", candidate: fakeCandidate({ job_id: "c" }) },
    {
      kind: "not-resumable",
      candidate: fakeCandidate({ job_id: "d" }),
      reason: "no target",
    },
  ];
  expect(countOutcomes(outcomes)).toEqual({
    restored: 1,
    failed: 1,
    wouldRestore: 1,
    notResumable: 1,
  });
});

// ---------------------------------------------------------------------------
// harness-aware restore — mixed-harness plan / render / launch
// ---------------------------------------------------------------------------

test("planRestore marks a candidate with no resume target not-resumable, would-restore the rest", () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "claude-a" }),
      fakeCandidate({
        job_id: "codex-b",
        harness: "codex",
        resume_target: "",
      }),
    ],
    null,
  );
  expect(plan.map((p) => p.kind)).toEqual(["would-restore", "not-resumable"]);
  expect((plan[1] as { reason: string }).reason).toContain("codex");
});

test("applyRestore passes each candidate's harness to ensureLaunched and skips a not-resumable one", async () => {
  const plan = planRestore(
    [
      fakeCandidate({ job_id: "j1", resume_target: "u1" }),
      fakeCandidate({
        job_id: "j2",
        harness: "codex",
        resume_target: "codex-id",
      }),
      fakeCandidate({ job_id: "j3", harness: "hermes", resume_target: "" }),
    ],
    null,
  );
  const calls: { resumeTarget: string; harness: string }[] = [];
  const out = await applyRestore(
    plan,
    async (_session, resumeTarget, _cwd, harness) => {
      calls.push({ resumeTarget, harness });
      return { ok: true };
    },
    async () => {},
  );
  expect(out.map((o) => o.kind)).toEqual([
    "restored",
    "restored",
    "not-resumable",
  ]);
  expect(calls).toEqual([
    { resumeTarget: "u1", harness: "claude" },
    { resumeTarget: "codex-id", harness: "codex" },
  ]);
});

test("renderOutcomes: per-harness resume command + a not-resumable stanza and summary note", () => {
  const plan = planRestore(
    [
      fakeCandidate({
        job_id: "cx",
        harness: "codex",
        resume_target: "rollout-9",
        label: "codex tab",
        cwd: "/repo",
      }),
      fakeCandidate({
        job_id: "hz",
        harness: "hermes",
        resume_target: "",
        label: "hermes tab",
      }),
    ],
    null,
  );
  const out = renderOutcomes(plan, false, 0);
  // codex renders its native subcommand resume form.
  expect(out).toContain('cd /repo && codex resume "rollout-9"');
  // the not-resumable agent is reported with a reason, no command line.
  expect(out).toContain("NOT-RESUMABLE hermes tab");
  expect(out).toContain("not-resumable=1");
});

test("renderSnapshotScript: a codex candidate emits `agent codex … resume`, a targetless one is a comment", () => {
  const script = renderSnapshotScript(
    [
      fakeCandidate({
        job_id: "cx",
        harness: "codex",
        resume_target: "rollout-9",
        label: "codex tab",
        cwd: "/repo",
      }),
      fakeCandidate({
        job_id: "hz",
        harness: "hermes",
        resume_target: "",
        label: "hermes tab",
      }),
    ],
    {
      prefix: RESTORE_PREFIX,
      tmuxSessionCwd: RESTORE_TMUX_SESSION_CWD,
      sourcePath: "/tmp/keeper.db",
    },
  );
  expect(script).toContain("'agent' 'codex'");
  expect(script).toContain("'resume' 'rollout-9'");
  expect(script).not.toContain("'--permission-mode'"); // codex omits claude flags
  expect(script).toContain(
    "# not-resumable: hermes tab (hermes session has no resolved resume target)",
  );
});

// ---------------------------------------------------------------------------
// selectRestoreGeneration — the richness-ranked auto-pick (the epic keystone)
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

test("selectRestoreGeneration flags ambiguous when the richest is not the freshest", () => {
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
  expect(sel.pickedGeneration?.generation_id).toBe("gen-rich");
  expect(sel.ambiguous).toBe(true);
  // Both eligible generations are offered in the picker menu.
  expect(sel.eligible.map((g) => g.generation_id).sort()).toEqual([
    "gen-fresh",
    "gen-rich",
  ]);
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
  kdb.db.close();

  const sel = loadRestorePlan(dbPath, { probeNow: () => "gen-now" });
  expect(sel.candidates.map((c) => c.job_id)).toEqual(["killed-cohort"]);
  expect(sel.pickedGeneration).toBeNull();
  expect(sel.fallbackNote).toBeDefined();
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
  kdb.db.close();

  const excluded = loadCurrentSetForDump(dbPath);
  expect(excluded.candidates.map((c) => c.job_id)).toEqual(["human-1"]);
  expect(excluded.excludedManagedCount).toBe(1);

  const included = loadCurrentSetForDump(dbPath, { includeManaged: true });
  expect(included.candidates.map((c) => c.job_id).sort()).toEqual([
    "human-1",
    "worker-1",
  ]);
  expect(included.excludedManagedCount).toBe(0);
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
