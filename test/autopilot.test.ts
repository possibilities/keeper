/**
 * Tests for `cli/autopilot.ts`'s block-2 filtered renderer.
 *
 * Block 2 in autopilot's frame body lists only the task pairs + close
 * pair whose readiness verdict is `{ tag: "ready" }`. The filtering is
 * driven by `renderEpicCommandsFiltered(epic, isReady)` — a pure
 * function over the embedded epic shape and a per-row verdict predicate.
 * A bug in the predicate or filter could silently drop ready epics from
 * (or add non-ready epics to) the autopilot work list, so this file
 * pins the three boundary cases the spec calls out:
 *
 *   (a) all-pass — every task and the close row pass; the filtered
 *       output is byte-identical to `renderEpicCommands` for the same
 *       epic.
 *   (b) some-pass — only a subset of the task pairs survive; the close
 *       row may or may not survive independently. Order is preserved
 *       and the dropped rows are gone from the output entirely.
 *   (c) none-pass — every kind returns false → renderer returns `null`
 *       and the epic is dropped from block 2.
 *
 * Importing the renderers directly from `cli/autopilot.ts` avoids
 * spawning a subprocess (matches the keeper convention used by the
 * other `test/*.test.ts` pure-function suites).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DetectJobTransitionsDeps,
  DispatchEntry,
  PendingLaunch,
} from "../cli/autopilot";
import {
  ARTHACK_ROOT,
  buildWorkerCommand,
  detectJobTransitions,
  drainPendingLaunches,
  hydrateDispatchLog,
  isLiveSessionInRoot,
  isSettlingGateFull,
  predictNextDispatches,
  releaseSettledKeys,
  renderEpicCommands,
  renderEpicCommandsFiltered,
  SETTLE_TIMEOUT_SEC,
  shouldSuppressDispatch,
  sweepSettleTimeouts,
  tryLaunch,
  validateShell,
} from "../cli/autopilot";
import { computeReadiness } from "../src/readiness";
import type { EmbeddedJob, Epic, Job, Task } from "../src/types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
    worker_phase: "open",
    runtime_status: "todo",
    approval: "approved",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic>): Epic {
  return {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    approval: "approved",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

const ALWAYS_READY = (_kind: "task" | "close", _id: string): boolean => true;
const NEVER_READY = (_kind: "task" | "close", _id: string): boolean => false;

test("renderEpicCommandsFiltered — all-pass matches renderEpicCommands byte-for-byte", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/other-repo",
      }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  const unfiltered = renderEpicCommands(epic);

  expect(filtered).not.toBeNull();
  expect(filtered).toBe(unfiltered);

  // Sanity-check the rendered shape: every claude line now routes through
  // `buildWorkerCommand` (fn-602.2), so each work/close command carries
  // `--model sonnet --effort max --name <verb>::<id>` and the per-task
  // `target_repo` override still wins for `.2`. None of these tasks
  // carries a `tier`, so the work-tier `--plugin-dir` is omitted.
  expect(filtered).toContain(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  expect(filtered).toContain(
    "cd /other-repo && claude --model sonnet --effort max --name work::fn-1-foo.2 '/plan:work fn-1-foo.2'",
  );
  expect(filtered).toContain(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.3 '/plan:work fn-1-foo.3'",
  );
  expect(filtered).toContain(
    "cd /repo && claude --model sonnet --effort max --name close::fn-1-foo '/plan:close fn-1-foo'",
  );
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
  // Tier-null work omits `--plugin-dir` entirely.
  expect(filtered).not.toContain("--plugin-dir");
});

test("renderEpicCommandsFiltered — some-pass keeps only ready rows, preserves order", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  // Only task .2 passes; close row drops out.
  const isReady = (kind: "task" | "close", id: string): boolean =>
    kind === "task" && id === "fn-1-foo.2";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();

  // .2 work + approve pair present (work command carries the
  // fn-602.2 flags via `buildWorkerCommand`).
  expect(filtered).toContain(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.2 '/plan:work fn-1-foo.2'",
  );
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo.2");

  // .1, .3, and the close pair are gone.
  expect(filtered).not.toContain("fn-1-foo.1");
  expect(filtered).not.toContain("fn-1-foo.3");
  expect(filtered).not.toContain("/plan:close fn-1-foo");
});

test("renderEpicCommandsFiltered — some-pass with surviving close row", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  // Only the close row passes; both task pairs drop.
  const isReady = (kind: "task" | "close", _id: string): boolean =>
    kind === "close";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain(
    "cd /repo && claude --model sonnet --effort max --name close::fn-1-foo '/plan:close fn-1-foo'",
  );
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
  expect(filtered).not.toContain("plan:work");
});

test("renderEpicCommandsFiltered — none-pass returns null (epic dropped from block 2)", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, NEVER_READY);
  expect(filtered).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with no ready close returns null", () => {
  // Epic with zero tasks and an unready close row: nothing to emit.
  const epic = makeEpic({ tasks: [] });
  expect(renderEpicCommandsFiltered(epic, NEVER_READY)).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with ready close emits close pair only", () => {
  const epic = makeEpic({ tasks: [] });
  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain("'/plan:close fn-1-foo'");
  expect(filtered).not.toContain("plan:work");
});

// ---------------------------------------------------------------------------
// buildWorkerCommand — the ONLY source of the `claude '/plan:<verb> <id>'`
// shell command for every autopilot consumer: the live
// `launchInGhostty` dispatch sites AND the display/dry-run renderers
// (`renderEpicCommands` / `renderEpicCommandsFiltered` / the predicted
// section's `v` toggle). fn-602.2 moves model/effort/work-tier-plugin
// selection upstream from `arthack-claude.py` into autopilot so the
// launcher knows nothing about planctl, tiers, or plan-role prompts.
//
// The emitted `--name` token MUST match the deriver regex in
// `src/derivers.ts` (`SPAWN_VERB_REF_RE`):
//   ^(plan|work|close|approve)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$
// Failure mode if the name is wrong (or absent): SessionStart's `ps`
// scrape yields null, `plan_ref` derives null, `syncJobIntoEpic` no-ops,
// and the spawned session never enters `task.jobs[]` — the readiness
// predicates and the per-root dispatch mutex go blind to it.
//
// Flag-mapping contract (per fn-602 epic spec):
//   - work, close → `--model sonnet --effort max`
//   - approve     → `--model sonnet --effort low`
//   - work        → additionally `--plugin-dir
//                   <ARTHACK_ROOT>/claude/work-plugins/<tier>`,
//                   SKIPPED when tier is null (degrade to launcher default)
// ---------------------------------------------------------------------------

// Mirror of the deriver regex at src/derivers.ts:88 — duplicated here so
// the test pins the on-the-wire contract independently of derivers.ts
// drift. If derivers.ts changes the regex, BOTH places must update.
const SPAWN_VERB_REF_RE =
  /^(plan|work|close|approve)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$/;

function extractNameToken(command: string): string | null {
  // Mirror of `nameFromArgs` at plugin/hooks/events-writer.ts:125. The
  // single-token rule matters: macOS `ps -o args=` space-joins argv, so
  // the scrape can only see the first whitespace-delimited token after
  // `--name `. The verb::id alphabet (`a-z`, `0-9`, `:`, `-`, `.`) has
  // no whitespace, so this is faithful as long as the dispatch helper
  // emits the form `--name <token> ` with a trailing space.
  const m = command.match(/(?:^|\s)(?:--name[= ]|-n )(\S+)/);
  return m?.[1] ?? null;
}

test("buildWorkerCommand — work carries sonnet+max, name, tier plugin-dir", () => {
  const cmd = buildWorkerCommand("work", "fn-1-foo.3", "/repo", "xhigh");
  expect(cmd.startsWith("cd /repo && ")).toBe(true);
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain("--effort max");
  expect(cmd).toContain("--name work::fn-1-foo.3");
  expect(cmd).toContain(
    `--plugin-dir ${ARTHACK_ROOT}/claude/work-plugins/xhigh`,
  );
  expect(cmd).toContain("'/plan:work fn-1-foo.3'");

  const token = extractNameToken(cmd) ?? "";
  expect(token).toBe("work::fn-1-foo.3");
  expect(SPAWN_VERB_REF_RE.test(token)).toBe(true);
});

test("buildWorkerCommand — tier-null work omits --plugin-dir (degrades to launcher default)", () => {
  const cmd = buildWorkerCommand("work", "fn-1-foo.3", "/repo", null);
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain("--effort max");
  expect(cmd).toContain("--name work::fn-1-foo.3");
  // No --plugin-dir flag at all; the launcher picks its own default.
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).toContain("'/plan:work fn-1-foo.3'");
});

test("buildWorkerCommand — work with tier omitted (undefined) behaves like tier=null", () => {
  // Call sites at the close/approve-close path pass no `tier` argument
  // at all; the work path may also pass `task.tier` which is `undefined`
  // on partial fixtures. Both must degrade identically.
  const cmd = buildWorkerCommand("work", "fn-1-foo.3", "/repo");
  expect(cmd).not.toContain("--plugin-dir");
});

test("buildWorkerCommand — close carries sonnet+max + name; no plugin-dir even when tier passed", () => {
  // Defensive: close is epic-level and has no tier, but call sites may
  // still pass `null`/`undefined` through the same helper signature.
  // The helper must IGNORE `tier` on non-`work` verbs.
  const cmd = buildWorkerCommand("close", "fn-1-foo", "/repo", "xhigh");
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain("--effort max");
  expect(cmd).toContain("--name close::fn-1-foo");
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).toContain("'/plan:close fn-1-foo'");

  const token = extractNameToken(cmd) ?? "";
  expect(token).toBe("close::fn-1-foo");
  expect(SPAWN_VERB_REF_RE.test(token)).toBe(true);
});

test("buildWorkerCommand — approve (task scope) carries sonnet+low + name; no plugin-dir", () => {
  const cmd = buildWorkerCommand("approve", "fn-1-foo.3", "/repo", "xhigh");
  expect(cmd).toContain("--model sonnet");
  expect(cmd).toContain("--effort low");
  expect(cmd).toContain("--name approve::fn-1-foo.3");
  expect(cmd).not.toContain("--plugin-dir");
  expect(cmd).toContain("'/plan:approve fn-1-foo.3'");

  const token = extractNameToken(cmd) ?? "";
  expect(token).toBe("approve::fn-1-foo.3");
  expect(SPAWN_VERB_REF_RE.test(token)).toBe(true);
});

test("buildWorkerCommand — approve (close scope) carries epic id", () => {
  const cmd = buildWorkerCommand("approve", "fn-1-foo", "/repo");
  expect(cmd).toContain("--effort low");
  expect(cmd).toContain("--name approve::fn-1-foo");
  expect(cmd).toContain("'/plan:approve fn-1-foo'");

  const token = extractNameToken(cmd) ?? "";
  expect(token).toBe("approve::fn-1-foo");
  expect(SPAWN_VERB_REF_RE.test(token)).toBe(true);
});

test("buildWorkerCommand — empty projectDir omits the cd prefix", () => {
  // `dir === ""` is the no-cd path taken when neither task.target_repo
  // nor epic.project_dir produced a non-empty `seg`. The bare command
  // must still carry the flags so the linkage + flag contracts hold
  // even when autopilot can't cd anywhere.
  const cmd = buildWorkerCommand("work", "fn-1-foo.3", "", null);
  expect(cmd.startsWith("cd ")).toBe(false);
  expect(cmd).toBe(
    "claude --model sonnet --effort max --name work::fn-1-foo.3 '/plan:work fn-1-foo.3'",
  );
});

test("buildWorkerCommand — name token is single-token (no spaces, no shell metachars)", () => {
  // macOS `ps -o args=` scrape only reads up to the first whitespace
  // after `--name `. A space in the token would silently truncate the
  // scrape. Also pins the no-shell-metachar property: the launchInGhostty
  // quoting chain (sh -c → /bin/zsh -l -i -c → AppleScript) is safe as
  // long as the verb::id token uses only `[a-z0-9:.-]`.
  for (const verb of ["work", "close", "approve"] as const) {
    for (const id of ["fn-1-foo", "fn-1-foo.3", "fn-638-harden-autopilot.12"]) {
      const cmd = buildWorkerCommand(verb, id, "/repo");
      const token = extractNameToken(cmd) ?? "";
      expect(token).not.toBe("");
      expect(token).not.toContain(" ");
      expect(token).toMatch(/^[a-z0-9:.-]+$/);
      expect(SPAWN_VERB_REF_RE.test(token)).toBe(true);
    }
  }
});

test("buildWorkerCommand — ARTHACK_ROOT is the absolute base for work plugin-dir", () => {
  // The constant is expanded once at module load (`~` → `homedir()`)
  // and routed through `buildWorkerCommand` for every work dispatch.
  // An accidentally-unexpanded `~` would surface as a literal `~/code/...`
  // path that the launcher's cwd would silently break.
  expect(ARTHACK_ROOT.startsWith("/")).toBe(true);
  expect(ARTHACK_ROOT.includes("~")).toBe(false);

  const cmd = buildWorkerCommand("work", "fn-1-foo.3", "/repo", "xhigh");
  expect(cmd).toContain(
    `--plugin-dir ${ARTHACK_ROOT}/claude/work-plugins/xhigh`,
  );
});

test("renderEpicCommands — work command carries tier --plugin-dir when task.tier is set", () => {
  // The display/dry-run renderer is the same helper used by the live
  // dispatch path — fn-602.2 routes both through `buildWorkerCommand`
  // so a tier on the task surfaces identically in copy-paste output.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", task_number: 1, tier: "max" })],
  });
  const rendered = renderEpicCommands(epic);
  expect(rendered).toContain(
    `--plugin-dir ${ARTHACK_ROOT}/claude/work-plugins/max`,
  );
  expect(rendered).toContain("--name work::fn-1-foo.1");
  expect(rendered).toContain("--model sonnet");
  expect(rendered).toContain("--effort max");
});

// ---------------------------------------------------------------------------
// predictNextDispatches — verb-aware simulation pass over `computeReadiness`.
//
// The function is a pure transform of the readiness snapshot, so each test
// builds an `Epic[]` fixture, runs `computeReadiness` to get the current
// verdicts, packages them into a `ReadinessClientSnapshot`, and asserts
// against the four preview buckets (approvals / informational / workers
// / closers — `informational` carries `git-dirty::<id>` rows that have
// no dispatch behind them).
//
// Pause-invariance is enforced by the function's signature — it takes only
// the snapshot and never reads autopilot's `paused` state — so the test
// matrix focuses on the verb-aware semantics rather than asserting an
// invariant the type system already pins.
// ---------------------------------------------------------------------------

function makeEmbeddedJob(overrides: Partial<EmbeddedJob>): EmbeddedJob {
  return {
    job_id: "session-1",
    plan_verb: "work",
    state: "working",
    title: null,
    created_at: 0,
    updated_at: 0,
    last_event_id: 0,
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  };
}

function buildSnap(
  epics: Epic[],
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  > = new Map(),
) {
  const jobs = new Map<string, Job>();
  const readiness = computeReadiness(epics, jobs, [], gitStatusByProjectDir);
  return {
    epics,
    completedEpics: [],
    jobs,
    subagentInvocations: [],
    gitStatus: [],
    // fn-643.5: `deadLetters` rides on every readiness snapshot. The
    // autopilot doesn't read it (the predict / detect / dispatch pipeline
    // is dead-letter-agnostic), so the helper stamps an empty array on
    // every fixture — same shape as the steady-state empty page from the
    // descriptor's `defaultFilter: { status: "waiting" }` scope.
    deadLetters: [],
    readiness,
  };
}

test("predictNextDispatches — in-flight worker on a task predicts approve::<task>", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.4",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker on a task does NOT predict approve::<epic> via close-row fan-up", () => {
  // The regression case from the user's autopilot frame: task .4's worker
  // is running, which fans the close-row up to blocked:job-running. Under
  // the old "active + not approved" rule, this spuriously emitted
  // approve::<epic> even though no closer had ever started. Under the
  // verb-aware simulation, the close-row stays at blocked:dep-on-task in
  // the future readiness pass (because .4 is sim'd to blocked:job-pending,
  // not completed), so approve::<epic> drops out.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
      makeTask({
        task_id: "fn-1-foo.5",
        task_number: 5,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  const ids = approvals.map((r) => `${r.verb}::${r.id}`);
  expect(ids).toContain("approve::fn-1-foo.4");
  expect(ids).not.toContain("approve::fn-1-foo");
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight approver on .3 plus worker on .4 yields approve::.4 only", () => {
  // The full frame from the bug report: approver on .3 + worker on .4 +
  // sibling .5 + epic close-row. Verb-aware sim collapses .3 to completed
  // (approve session ending → approval=approved), .4 to blocked:job-pending
  // (worker ending → worker_phase=done with approval still pending), and
  // leaves .5 + close-row untouched. Only approve::.4 emits; the spurious
  // approve::<epic> from the old code disappears.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.3",
        task_number: 3,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            job_id: "session-3a",
            plan_verb: "approve",
            state: "working",
          }),
        ],
      }),
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            job_id: "session-4",
            plan_verb: "work",
            state: "working",
          }),
        ],
      }),
      makeTask({
        task_id: "fn-1-foo.5",
        task_number: 5,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.4",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight closer on the epic predicts approve::<epic>", () => {
  // Closer is the close-row's own in-flight job, so its completion flips
  // epic.status="done" and (with approval still pending) the close-row's
  // future verdict is blocked:job-pending → approve::<epic>.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "approved",
      }),
    ],
    status: "open",
    approval: "pending",
    jobs: [makeEmbeddedJob({ plan_verb: "close", state: "working" })],
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — a ready task predicts approve::<task> as the next step after section-1 dispatch", () => {
  // A task at cur=ready has its worker dispatched into section 1 right
  // now. Section 2's job is to preview the step AFTER that — which is
  // approve::<task> once the worker ends with approval still pending.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  // Sanity: confirm the fixture really produces a ready task verdict —
  // the assertion that follows depends on this precondition.
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("ready");
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — no in-flight jobs and no ready rows yields empty preview", () => {
  // Every task is already completed and the close-row is ready (status
  // still open, approval=pending). One row is ready, so the simulation
  // touches the tree, but the diff produces only the approve::<epic>
  // prediction for the close-row — no workers, no closers from
  // downstream tasks.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "approved",
      }),
    ],
    status: "open",
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  expect(snap.readiness.perCloseRow.get("fn-1-foo")?.tag).toBe("ready");
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — empty preview when nothing is running and nothing is ready", () => {
  // Every row is either completed or blocked behind a human action that
  // isn't currently in flight — the preview should be empty.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
      }),
    ],
    status: "open",
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  // Task is blocked:job-pending (worker done, awaiting approval).
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "job-pending" },
  });
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker with git_dirty_count > 0 still predicts approve::<task>", () => {
  // The sim zeros git counts on the working→ended flip — it models a
  // worker that finishes AND commits before going idle, so predicate 6.5
  // (git-uncommitted) does NOT fire in futureReadiness and mask the
  // approve prediction. Current readiness is still blocked:job-running
  // (predicate 5), so the informational pre-pass (which reads `cur`,
  // not the simulated `fut`) skips the `git-dirty::<id>` row — that
  // gate is reserved for "worker actually stopped dirty", caught off
  // current state once `worker_phase` flips to done for real.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "working",
            git_dirty_count: 3,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  const { approvals, informational, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(informational).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker with git_orphan_count > 0 still predicts approve::<task>", () => {
  // Sibling case: same sim-zeroing applies to git_orphan_count, so a
  // running worker with orphans queued in its worktree still predicts
  // approve. The informational gate stays cur-driven and only fires
  // once the worker actually stops with orphans still present.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "working",
            git_dirty_count: 0,
            git_orphan_count: 2,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  const { approvals, informational, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(informational).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — stopped worker + worker_phase=done + git_dirty_count > 0 emits informational git-dirty::<task>", () => {
  // The actual emit condition: the worker has stopped (state !==
  // "working"), planctl stamped worker_phase=done, but the worktree
  // still has uncommitted files → readiness predicate 6.5 fires for
  // real (not just in the sim) → cur=blocked:git-uncommitted → the
  // informational pre-pass picks it up.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "ended",
            git_dirty_count: 3,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  // fn-626: predicate 6.5 now reads off the live project-wide `git_status`
  // map, not the embedded per-job columns. Feed a map entry whose
  // dirty_count > 0 to drive the predicate.
  const gitMap = new Map([
    ["/repo", { dirty_count: 3, unattributed_to_live_count: 0 }],
  ]);
  const snap = buildSnap([epic], gitMap);
  // Sanity check that the readiness predicate actually fires.
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "git-uncommitted" },
  });
  const { approvals, informational, workers, closers } =
    predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(informational.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "git-dirty::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — stopped worker + worker_phase=done + git_orphan_count > 0 also emits informational git-dirty::<task>", () => {
  // Sibling: predicate 6.5's `git-orphans` branch in real readiness
  // also drives the informational row.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "ended",
            git_dirty_count: 0,
            git_orphan_count: 2,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  // fn-626: feed the live `git_status` map — predicate 6.5 reads from
  // there now, not the embedded per-job columns.
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 2 }],
  ]);
  const snap = buildSnap([epic], gitMap);
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "git-orphans" },
  });
  const { approvals, informational, workers, closers } =
    predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(informational.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "git-dirty::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

// ---------------------------------------------------------------------------
// detectJobTransitions — fulfilled-then-disappeared rule.
//
// `detectJobTransitions` migrates a dispatched row across three states
// (queued → current → completed) by folding successive readiness
// snapshots. The terminal-state branch (`state in ("ended", "killed")`)
// has shipped since the original autopilot frame; the new branch
// added by fn-623.1 fires `current → completed` when a *previously
// fulfilled* dispatch's matching job has *disappeared* from the
// snapshot entirely — the parent epic has fallen off the default
// subscription scope after becoming done+approved, or a human ran
// `planctl epic-delete` against the target.
//
// The branch is gated on `fulfilledKeys.has(key)` so a queued
// dispatch whose agent has not yet booted (also a `findSessionJob
// === undefined` shape) cannot migrate to completed instantly. This
// test pins all three load-bearing properties in one case:
//   (a) frame 1: fulfilled epic+embedded-job → `fulfilledKeys` gains
//       the key and a `kind:"fulfilled"` line is recorded.
//   (b) frame 2: same key, epic gone from the snap → `completedKeys`
//       gains the key and a `kind:"completed"` line is recorded.
//   (c) frame 3: same empty snap → no second `completed` line
//       (idempotence via the `completedKeys.has(key)` guard at the
//       top of the loop).
// Bonus: a never-fulfilled queued dispatch in the same frames stays
// absent from both sets — proves the `fulfilledKeys` gate.
// ---------------------------------------------------------------------------

function makeDispatchEntry(overrides: Partial<DispatchEntry>): DispatchEntry {
  return {
    ts: "2026-05-27T00:00:00.000Z",
    kind: "launch",
    rowId: "row-1",
    dir: "repo",
    dirFull: "/repo",
    verb: "approve",
    id: "fn-1-foo",
    command: "cd /repo && claude '/plan:approve fn-1-foo'",
    pid: 42,
    ...overrides,
  };
}

test("detectJobTransitions — fulfilled key disappears from snapshot reaches completed", () => {
  // Two dispatches in the log: one will be fulfilled then disappear,
  // one is queued and never appears (proves the `fulfilledKeys`
  // gate).
  const fulfilledEntry = makeDispatchEntry({
    verb: "approve",
    id: "fn-1-foo",
  });
  const neverFulfilledEntry = makeDispatchEntry({
    verb: "approve",
    id: "fn-2-bar",
  });
  const dispatchLog: DispatchEntry[] = [fulfilledEntry, neverFulfilledEntry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const captured: string[] = [];
  const noteLines: string[] = [];
  const closedIds: Array<string | undefined> = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: (s) => noteLines.push(s),
    pid: 4242,
    appendLine: (line) => captured.push(line),
    closeWindow: (id) => closedIds.push(id),
  };

  // Frame (a): the dispatched epic is on the page with a matching
  // embedded job → `fulfilledKeys` gains the key and a
  // `kind:"fulfilled"` line is recorded. The never-fulfilled entry
  // has no epic in the snap, so it must stay absent from both sets.
  const frame1Epic = makeEpic({
    epic_id: "fn-1-foo",
    jobs: [makeEmbeddedJob({ plan_verb: "approve", state: "working" })],
  });
  const snap1 = buildSnap([frame1Epic]);
  detectJobTransitions(deps, snap1);

  expect(fulfilledKeys.has("approve::fn-1-foo")).toBe(true);
  expect(completedKeys.has("approve::fn-1-foo")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(captured.length).toBe(1);
  const fulfilledLine = JSON.parse(captured[0] ?? "{}") as Record<
    string,
    unknown
  >;
  expect(fulfilledLine.kind).toBe("fulfilled");
  expect(fulfilledLine.verb).toBe("approve");
  expect(fulfilledLine.id).toBe("fn-1-foo");
  expect(typeof fulfilledLine.ts).toBe("string");
  expect(typeof fulfilledLine.pid).toBe("number");
  expect(fulfilledLine.pid).toBe(4242);
  // The completed shape is intentionally lean — no `reason` field.
  expect("reason" in fulfilledLine).toBe(false);

  // Frame (b): the epic has fallen off the page (e.g. became
  // done+approved and exited the default scope). The fulfilled
  // dispatch's matching job is now undefined; combined with
  // `fulfilledKeys.has(key)`, the disappearance branch fires →
  // `completedKeys` gains the key and a `kind:"completed"` line
  // lands. The never-fulfilled entry STILL has no matching job and
  // STILL is not in `fulfilledKeys`, so the gate keeps it queued.
  const snap2 = buildSnap([]);
  detectJobTransitions(deps, snap2);

  expect(completedKeys.has("approve::fn-1-foo")).toBe(true);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
  expect(captured.length).toBe(2);
  const completedLine = JSON.parse(captured[1] ?? "{}") as Record<
    string,
    unknown
  >;
  expect(completedLine.kind).toBe("completed");
  expect(completedLine.verb).toBe("approve");
  expect(completedLine.id).toBe("fn-1-foo");
  expect(typeof completedLine.ts).toBe("string");
  expect(typeof completedLine.pid).toBe("number");
  expect(completedLine.pid).toBe(4242);
  expect("reason" in completedLine).toBe(false);

  // Frame (c): a third call with the same empty snap → no second
  // `completed` line. The `completedKeys.has(key)` guard at the top
  // of the loop short-circuits before the disappearance branch is
  // reached. The never-fulfilled entry remains queued.
  detectJobTransitions(deps, snap2);
  expect(captured.length).toBe(2);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
  // closeWindow MUST have been invoked exactly once — when frame (b)
  // migrated the row to `completedKeys` via the disappearance branch.
  // The entry carried no windowId (test fixture omitted it), so the
  // recorded id is `undefined` — the production closeWindow no-ops on
  // that shape, but the call site must still fire so a future
  // entry-with-windowId is auto-closed at the same edge.
  expect(closedIds).toEqual([undefined]);
});

// ---------------------------------------------------------------------------
// detectJobTransitions — fn-640.1 auto-close trigger.
//
// Two new properties pin the auto-close wiring at both
// `completedKeys`-entry sites:
//   - The terminal-state branch (`state in {"ended","killed"}`) fires
//     `closeWindow(entry.windowId)` AND the disappearance branch does
//     the same. The recording stub captures the exact id passed
//     through so a windowId-stamped entry is reaped.
//   - The `completedKeys.has(key)` top-of-loop guard suppresses any
//     second close on a repeat tick.
// ---------------------------------------------------------------------------

test("detectJobTransitions — closeWindow fires with entry.windowId at terminal-state edge AND on repeat tick stays silent", () => {
  // Entry carries a stamped windowId from the live-spawn capture. A
  // matching embedded job in `working` state on frame 1 → fulfilled;
  // on frame 2 the job is `ended` → completed branch fires, AND
  // closeWindow(windowId) lands.
  const entry = makeDispatchEntry({
    verb: "work",
    id: "fn-1-foo.1",
    dir: "repo",
    dirFull: "/repo",
    windowId: "tab-group-DEADBEEF",
  });
  const dispatchLog: DispatchEntry[] = [entry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const captured: string[] = [];
  const closedIds: Array<string | undefined> = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: () => {},
    pid: 4242,
    appendLine: (line) => captured.push(line),
    closeWindow: (id) => closedIds.push(id),
  };

  // Frame 1: working job → fulfilled. No close yet.
  const taskWorking = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
  });
  const snap1 = buildSnap([makeEpic({ tasks: [taskWorking] })]);
  detectJobTransitions(deps, snap1);
  expect(fulfilledKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(false);
  expect(closedIds).toEqual([]);

  // Frame 2: job ended → terminal-state branch fires. completedKeys
  // gains the key, completed line lands, closeWindow(windowId) fires.
  const taskEnded = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "ended" })],
  });
  const snap2 = buildSnap([makeEpic({ tasks: [taskEnded] })]);
  detectJobTransitions(deps, snap2);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(closedIds).toEqual(["tab-group-DEADBEEF"]);

  // Frame 3: same ended snap → `completedKeys.has(key)` short-circuits
  // at the top of the loop, no second close fires.
  detectJobTransitions(deps, snap2);
  expect(closedIds).toEqual(["tab-group-DEADBEEF"]);
});

test("detectJobTransitions — closeWindow fires with entry.windowId at disappearance edge", () => {
  // Sibling case: post-fulfillment, the matching job disappears from
  // the snapshot (parent epic became done+approved). Same auto-close
  // path as the terminal-state branch.
  const entry = makeDispatchEntry({
    verb: "approve",
    id: "fn-1-foo",
    dir: "repo",
    dirFull: "/repo",
    windowId: "tab-group-CAFEBABE",
  });
  const dispatchLog: DispatchEntry[] = [entry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const closedIds: Array<string | undefined> = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: () => {},
    pid: 4242,
    appendLine: () => {},
    closeWindow: (id) => closedIds.push(id),
  };

  // Frame 1: epic + matching approve job → fulfilled.
  const snap1 = buildSnap([
    makeEpic({
      epic_id: "fn-1-foo",
      jobs: [makeEmbeddedJob({ plan_verb: "approve", state: "working" })],
    }),
  ]);
  detectJobTransitions(deps, snap1);
  expect(fulfilledKeys.has("approve::fn-1-foo")).toBe(true);
  expect(closedIds).toEqual([]);

  // Frame 2: epic gone → disappearance branch fires (gated on
  // fulfilledKeys). closeWindow lands with the stamped id.
  detectJobTransitions(deps, buildSnap([]));
  expect(completedKeys.has("approve::fn-1-foo")).toBe(true);
  expect(closedIds).toEqual(["tab-group-CAFEBABE"]);
});

// ---------------------------------------------------------------------------
// detectJobTransitions — stopped-while-board-verdict-completed trigger.
//
// A worker that finished its task and got approved parks at
// `state === "stopped"` (its Ghostty window is still open) — it never
// reaches `ended`/`killed` until the human closes the window. board.ts
// already shows the task `[completed]`. This trigger migrates such a
// row to `--- completed ---` AND fires `closeWindow` so the parked
// surface is reaped in lockstep with the work being done — the same
// edge that was previously dead for stopped sessions.
//
// Two properties pinned:
//   (a) stopped job + board verdict completed (worker_phase done +
//       approved) → completed + closeWindow.
//   (b) stopped job whose verdict is NOT completed (worker done but
//       approval pending) stays under `--- current ---` — no migration,
//       no close.
// ---------------------------------------------------------------------------

test("detectJobTransitions — stopped job whose board verdict is completed migrates and closes window", () => {
  const entry = makeDispatchEntry({
    verb: "work",
    id: "fn-1-foo.1",
    dir: "repo",
    dirFull: "/repo",
    windowId: "tab-group-F00DCAFE",
  });
  const dispatchLog: DispatchEntry[] = [entry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const captured: string[] = [];
  const closedIds: Array<string | undefined> = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: () => {},
    pid: 4242,
    appendLine: (line) => captured.push(line),
    closeWindow: (id) => closedIds.push(id),
  };

  // Frame 1: worker still running → fulfilled, no completion yet.
  const taskWorking = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    worker_phase: "open",
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
  });
  detectJobTransitions(deps, buildSnap([makeEpic({ tasks: [taskWorking] })]));
  expect(fulfilledKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(false);
  expect(closedIds).toEqual([]);

  // Frame 2: worker finished + approved (board verdict `completed`) but
  // the session is parked at `stopped` (window still open, NOT ended).
  // The stopped-and-board-complete branch fires.
  const taskDone = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "stopped" })],
  });
  const snapDone = buildSnap([makeEpic({ tasks: [taskDone] })]);
  // Guard: the board verdict really is `completed` (mirrors board.ts).
  expect(snapDone.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("completed");
  detectJobTransitions(deps, snapDone);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(closedIds).toEqual(["tab-group-F00DCAFE"]);
  const line = JSON.parse(captured.at(-1) ?? "{}") as Record<string, unknown>;
  expect(line.kind).toBe("completed");
  expect(line.verb).toBe("work");
  expect(line.id).toBe("fn-1-foo.1");
});

test("detectJobTransitions — stopped job that is NOT board-completed stays current", () => {
  const entry = makeDispatchEntry({
    verb: "work",
    id: "fn-1-foo.1",
    dir: "repo",
    dirFull: "/repo",
    windowId: "tab-group-BADBADBAD",
  });
  const dispatchLog: DispatchEntry[] = [entry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const closedIds: Array<string | undefined> = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: () => {},
    pid: 4242,
    appendLine: () => {},
    closeWindow: (id) => closedIds.push(id),
  };

  // Worker finished (worker_phase done) but approval is still pending —
  // board verdict is `blocked:job-pending`, NOT `completed`. A stopped
  // session here must NOT migrate or close: it's awaiting human approval.
  const taskPending = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "stopped" })],
  });
  const snap = buildSnap([makeEpic({ tasks: [taskPending] })]);
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).not.toBe("completed");
  detectJobTransitions(deps, snap);
  detectJobTransitions(deps, snap);
  expect(fulfilledKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(false);
  expect(closedIds).toEqual([]);
});

// ---------------------------------------------------------------------------
// hydrateDispatchLog — fn-640.1 window-row fold.
//
// A new `kind:"window"` row carries the spawned Ghostty window's id;
// pass 2 stamps that id onto the matching surviving restored launch
// entry so cross-run auto-close still works. Three properties to pin:
//   (a) window row folds windowId onto the matching restored entry.
//   (b) latest-ts-wins on duplicate window rows for the same (verb, id).
//   (c) an old log with no window row leaves windowId undefined.
// ---------------------------------------------------------------------------

test("hydrateDispatchLog — window row folds windowId onto matching restored entry", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    {
      kind: "window",
      ts: "2026-05-27T00:00:01.500Z",
      verb: "work",
      id: "fn-1-foo.1",
      windowId: "tab-group-AAA",
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(1);
  const entry = restoredEntries[0] as DispatchEntry;
  expect(entry.windowId).toBe("tab-group-AAA");
});

test("hydrateDispatchLog — duplicate window rows for same (verb, id) → latest-ts wins", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    // Out-of-order on purpose so the test asserts the ts comparison,
    // not the insertion order.
    {
      kind: "window",
      ts: "2026-05-27T00:00:05.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      windowId: "tab-group-NEW",
    },
    {
      kind: "window",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      windowId: "tab-group-OLD",
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:06.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(1);
  expect(restoredEntries[0]?.windowId).toBe("tab-group-NEW");
});

test("hydrateDispatchLog — log with no window row leaves windowId undefined on restored entry", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(1);
  expect(restoredEntries[0]?.windowId).toBeUndefined();
});

test("hydrateDispatchLog — malformed window row (non-string windowId) skips silently", () => {
  // Forensic-log contract: a shape mismatch on a window row skips
  // without throwing; the rest of the log still hydrates. Pinned so
  // a future log-format quirk doesn't wedge startup.
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    {
      kind: "window",
      ts: "2026-05-27T00:00:01.500Z",
      verb: "work",
      id: "fn-1-foo.1",
      windowId: 12345, // wrong type
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(1);
  expect(restoredEntries[0]?.windowId).toBeUndefined();
});

// ---------------------------------------------------------------------------
// hydrateDispatchLog — restoredEntries cross-run survival of `--- current ---`.
//
// `hydrateDispatchLog` already folded the three durable sets
// (`dispatchedKeys` / `fulfilledKeys` / `completedKeys`) before
// fn-625; this batch widens its return shape with `restoredEntries:
// DispatchEntry[]` so prior-run launches that are
// `fulfilled && !completed && !dry` can re-populate the in-memory
// `dispatchLog` array on startup. The filter is the contract the
// section partition logic in `renderDispatchFrame` consumes
// downstream — restored entries automatically land under
// `--- current ---` because their key is in `fulfilledKeys` but not
// `completedKeys`. The seven cases below pin every load-bearing
// property the task spec calls out.
// ---------------------------------------------------------------------------

function writeDispatchLog(rows: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-autopilot-hydrate-"));
  const path = join(dir, "dispatch.log");
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

test("hydrateDispatchLog — launch + fulfilled + !completed + !dry → restored", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries, fulfilledKeys, completedKeys } =
    hydrateDispatchLog(path);
  expect(fulfilledKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(false);
  expect(restoredEntries.length).toBe(1);
  const entry = restoredEntries[0] as DispatchEntry;
  expect(entry.verb).toBe("work");
  expect(entry.id).toBe("fn-1-foo.1");
  expect(entry.dir).toBe("repo");
  expect(entry.dirFull).toBe("/repo");
  expect(entry.command).toBe("cd /repo && claude '/plan:work fn-1-foo.1'");
  expect(entry.ts).toBe("2026-05-27T00:00:01.000Z");
  expect(entry.dry).toBeUndefined();
  expect(entry.pid).toBe(42);
});

test("hydrateDispatchLog — launch + fulfilled + completed → NOT restored", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
    {
      kind: "completed",
      ts: "2026-05-27T00:00:03.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries, completedKeys } = hydrateDispatchLog(path);
  expect(completedKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(restoredEntries.length).toBe(0);
});

test("hydrateDispatchLog — launch only (no fulfilled) → NOT restored", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      pid: 42,
    },
  ]);
  const { restoredEntries, dispatchedKeys, fulfilledKeys } =
    hydrateDispatchLog(path);
  expect(dispatchedKeys.has("work::fn-1-foo.1")).toBe(true);
  expect(fulfilledKeys.has("work::fn-1-foo.1")).toBe(false);
  expect(restoredEntries.length).toBe(0);
});

test("hydrateDispatchLog — dry launch + fulfilled → NOT restored", () => {
  // Dry launches can never reach fulfillment in production (no real
  // session boots), but pinning the dry filter independently of that
  // invariant prevents a future log-format quirk from leaking a dry
  // entry into the live UI.
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-1",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1'",
      dry: true,
      pid: 42,
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:02.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(0);
});

test("hydrateDispatchLog — two launches same (verb,id) different ts → latest wins", () => {
  const path = writeDispatchLog([
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-old",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1' OLD",
      pid: 41,
    },
    {
      kind: "launch",
      ts: "2026-05-27T00:00:05.000Z",
      rowId: "row-new",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "cd /repo && claude '/plan:work fn-1-foo.1' NEW",
      pid: 42,
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:06.000Z",
      verb: "work",
      id: "fn-1-foo.1",
      pid: 42,
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(1);
  const entry = restoredEntries[0] as DispatchEntry;
  expect(entry.rowId).toBe("row-new");
  expect(entry.command).toBe("cd /repo && claude '/plan:work fn-1-foo.1' NEW");
  expect(entry.ts).toBe("2026-05-27T00:00:05.000Z");
  expect(entry.pid).toBe(42);
});

test("hydrateDispatchLog — multiple keys → restoredEntries sorted by ts ascending", () => {
  const path = writeDispatchLog([
    // Intentionally write launches out of `ts` order to prove the
    // sort step (not just insertion order) is the source of the
    // ascending arrangement.
    {
      kind: "launch",
      ts: "2026-05-27T00:00:05.000Z",
      rowId: "row-c",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-3-baz.1",
      command: "c",
    },
    {
      kind: "launch",
      ts: "2026-05-27T00:00:01.000Z",
      rowId: "row-a",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-1-foo.1",
      command: "a",
    },
    {
      kind: "launch",
      ts: "2026-05-27T00:00:03.000Z",
      rowId: "row-b",
      dir: "repo",
      dirFull: "/repo",
      verb: "work",
      id: "fn-2-bar.1",
      command: "b",
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:10.000Z",
      verb: "work",
      id: "fn-1-foo.1",
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:11.000Z",
      verb: "work",
      id: "fn-2-bar.1",
    },
    {
      kind: "fulfilled",
      ts: "2026-05-27T00:00:12.000Z",
      verb: "work",
      id: "fn-3-baz.1",
    },
  ]);
  const { restoredEntries } = hydrateDispatchLog(path);
  expect(restoredEntries.length).toBe(3);
  expect(restoredEntries.map((e) => e.id)).toEqual([
    "fn-1-foo.1",
    "fn-2-bar.1",
    "fn-3-baz.1",
  ]);
  expect(restoredEntries.map((e) => e.ts)).toEqual([
    "2026-05-27T00:00:01.000Z",
    "2026-05-27T00:00:03.000Z",
    "2026-05-27T00:00:05.000Z",
  ]);
});

test("hydrateDispatchLog — missing file → empty restoredEntries (no throw)", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-autopilot-hydrate-"));
  const path = join(dir, "does-not-exist.log");
  const result = hydrateDispatchLog(path);
  expect(result.restoredEntries).toEqual([]);
  expect(result.dispatchedKeys.size).toBe(0);
  expect(result.fulfilledKeys.size).toBe(0);
  expect(result.completedKeys.size).toBe(0);
});

// ---------------------------------------------------------------------------
// fn-638.3: shouldSuppressDispatch + isLiveSessionInRoot
//
// The two pure helpers behind `launchInGhostty`'s pre-spawn gate.
//
// shouldSuppressDispatch reconciles three suppression mechanisms:
//   (1) `work`/`close` once-for-life launch suppression via
//       `dispatchedKeys` — double-spawning a worker risks git corruption.
//   (2) `approve` fulfillment suppression via `fulfilledKeys` — a
//       dismissed approve window must re-dispatch on the next
//       `job-pending` edge to self-heal.
//   (3) Pre-spawn live-session-in-root gate — refuse a second dispatch
//       to a root that already hosts a live session (running-tag verdict
//       OR launched-but-unfulfilled dispatch), self excluded, fail-closed
//       on a partial snapshot.
//
// The test matrix below pins every load-bearing edge the spec calls out:
//   (a) dismissed approve (launch, no fulfilled) → re-dispatch ALLOWED
//   (b) fulfilled approve → re-dispatch SUPPRESSED via fulfilled
//   (c) work / close → re-dispatch SUPPRESSED via dispatchedKeys for life
//   (d) live `running`-tag sibling in root → SUPPRESSED via live-in-root
//   (e) launched-but-unfulfilled dispatch in same root → SUPPRESSED
//   (f) self is excluded (a row never blocks its own dispatch)
//   (g) empty/null snapshot → fail-closed (SUPPRESSED via live-in-root)
//   (h) different root → not suppressed
// ---------------------------------------------------------------------------

test("shouldSuppressDispatch — dismissed approve re-dispatches on next job-pending edge", () => {
  // Approve was launched once (dispatchedKeys has the key, dispatch
  // log carries the launch row) but never fulfilled (no embedded job
  // ever appeared — the human dismissed the window). The next
  // `job-pending` edge MUST be allowed through; otherwise everything
  // queued behind this approve deadlocks for life.
  const dispatchedKeys = new Set<string>(["approve::fn-1-foo.1"]);
  const fulfilledKeys = new Set<string>();
  const launchEntry = makeDispatchEntry({
    verb: "approve",
    id: "fn-1-foo.1",
    dir: "repo",
    dirFull: "/repo",
  });
  const dispatchLog: DispatchEntry[] = [launchEntry];
  // Snap carries the task at blocked:job-pending (any non-empty snap
  // where the row has no live sibling will do — the
  // `isLiveSessionInRoot` branch must NOT fire for self).
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  const reason = shouldSuppressDispatch(
    "approve",
    "fn-1-foo.1",
    "/repo",
    snap,
    dispatchedKeys,
    fulfilledKeys,
    dispatchLog,
  );
  expect(reason).toBeNull();
});

test("shouldSuppressDispatch — fulfilled approve is suppressed for life", () => {
  // Approve was launched AND fulfilled (an embedded job appeared,
  // marking the key in fulfilledKeys). A re-edge MUST be suppressed —
  // a second window for an already-running approve is the original
  // double-fire bug the durable guard prevents.
  const dispatchedKeys = new Set<string>(["approve::fn-1-foo.1"]);
  const fulfilledKeys = new Set<string>(["approve::fn-1-foo.1"]);
  const epic = makeEpic({ project_dir: "/repo" });
  const snap = buildSnap([epic]);
  const reason = shouldSuppressDispatch(
    "approve",
    "fn-1-foo.1",
    "/repo",
    snap,
    dispatchedKeys,
    fulfilledKeys,
    [],
  );
  expect(reason).toBe("fulfilled-suppressed");
});

test("shouldSuppressDispatch — work is launch-suppressed for life (NOT fulfillment-keyed)", () => {
  // Work has been launched (dispatchedKeys carries the key) but never
  // fulfilled — e.g. the agent crashed before SessionStart. This MUST
  // stay suppressed; re-dispatching a worker risks two live workers
  // on the same task and git corruption. The fulfillment-keying carve-
  // out is approve-only.
  const dispatchedKeys = new Set<string>(["work::fn-1-foo.1"]);
  const fulfilledKeys = new Set<string>();
  const epic = makeEpic({ project_dir: "/repo" });
  const snap = buildSnap([epic]);
  const reason = shouldSuppressDispatch(
    "work",
    "fn-1-foo.1",
    "/repo",
    snap,
    dispatchedKeys,
    fulfilledKeys,
    [],
  );
  expect(reason).toBe("launch-suppressed");
});

test("shouldSuppressDispatch — close is launch-suppressed for life (NOT fulfillment-keyed)", () => {
  // Symmetric to work: close keeps once-for-life launch suppression.
  const dispatchedKeys = new Set<string>(["close::fn-1-foo"]);
  const fulfilledKeys = new Set<string>();
  const epic = makeEpic({ project_dir: "/repo" });
  const snap = buildSnap([epic]);
  const reason = shouldSuppressDispatch(
    "close",
    "fn-1-foo",
    "/repo",
    snap,
    dispatchedKeys,
    fulfilledKeys,
    [],
  );
  expect(reason).toBe("launch-suppressed");
});

test("shouldSuppressDispatch — live running sibling in same root suppresses second dispatch", () => {
  // Two tasks share the same effective root (epic.project_dir).
  // task .1 has a working embedded job → running-tag verdict. A
  // dispatch for task .2 in the same root MUST be suppressed — two
  // live workers in one repo is the git-corruption scenario the gate
  // exists to prevent.
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        worker_phase: "open",
        approval: "approved",
        depends_on: [],
      }),
    ],
  });
  const snap = buildSnap([epic]);
  // Sanity: .1 must be at a running-tag verdict for this test to
  // exercise the live-in-root branch (vs. a dispatch-log gap).
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("running");
  const reason = shouldSuppressDispatch(
    "work",
    "fn-1-foo.2",
    "/repo",
    snap,
    new Set(),
    new Set(),
    [],
  );
  expect(reason).toBe("live-in-root");
});

test("shouldSuppressDispatch — launched-but-unfulfilled dispatch in same root suppresses second dispatch", () => {
  // Pure dispatch-log branch: no snapshot signal yet, but a sibling
  // dispatch fired moments ago and the SessionStart fold has not
  // round-tripped. The propagation gap is closed by `dispatchLog` +
  // `!fulfilledKeys` for the OTHER key in the same root.
  const dispatchLog: DispatchEntry[] = [
    makeDispatchEntry({
      verb: "work",
      id: "fn-1-foo.1",
      dir: "repo",
      dirFull: "/repo",
    }),
  ];
  // Snap carries the epic so we pass the fail-closed gate, but no
  // running-tag verdict yet (the freshly-launched session is still in
  // the propagation gap before SessionStart folds).
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
      }),
    ],
  });
  const snap = buildSnap([epic]);
  const reason = shouldSuppressDispatch(
    "work",
    "fn-1-foo.2",
    "/repo",
    snap,
    new Set(),
    new Set(),
    dispatchLog,
  );
  expect(reason).toBe("live-in-root");
});

test("shouldSuppressDispatch — self is excluded from live-in-root gate (does not block own dispatch)", () => {
  // The row being dispatched has a launch log line (just fired) but
  // is the row we're checking. Self-exclusion via `(verb, id)` is
  // load-bearing: without it the gate would refuse every re-dispatch
  // edge after a launch line lands. The previous test already proved
  // the gate fires for OTHER rows in the same root.
  const dispatchLog: DispatchEntry[] = [
    makeDispatchEntry({
      verb: "approve",
      id: "fn-1-foo.1",
      dir: "repo",
      dirFull: "/repo",
    }),
  ];
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  // Same `(verb, id)` as the dispatch log entry → must be excluded
  // from BOTH branches of the gate.
  const reason = shouldSuppressDispatch(
    "approve",
    "fn-1-foo.1",
    "/repo",
    snap,
    new Set(),
    new Set(),
    dispatchLog,
  );
  expect(reason).toBeNull();
});

test("isLiveSessionInRoot — null snapshot fails closed (suppresses)", () => {
  // The "snapshot staleness post-reconnect" risk: bias false-negative-
  // safe (suppress) when we cannot verify.
  const result = isLiveSessionInRoot(
    null,
    "/repo",
    "work",
    "fn-1-foo.1",
    [],
    new Set(),
  );
  expect(result).toBe(true);
});

test("isLiveSessionInRoot — empty-epics snapshot fails closed (suppresses)", () => {
  // A snapshot with zero epics is indistinguishable from "haven't
  // synced yet" — suppress. Same fail-closed bias as null.
  const snap = buildSnap([]);
  const result = isLiveSessionInRoot(
    snap,
    "/repo",
    "work",
    "fn-1-foo.1",
    [],
    new Set(),
  );
  expect(result).toBe(true);
});

test("isLiveSessionInRoot — live session in DIFFERENT root does not suppress", () => {
  // Two epics in different repos. A running-tag verdict in /other-repo
  // must NOT block a dispatch into /repo — the gate is per-root, not
  // global. This is the multi-project-concurrency baseline.
  const liveEpic = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/other-repo",
    sort_path: "000002",
    tasks: [
      makeTask({
        epic_id: "fn-2-bar",
        task_id: "fn-2-bar.1",
        task_number: 1,
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
    ],
  });
  const targetEpic = makeEpic({
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1", task_number: 1 })],
  });
  const snap = buildSnap([liveEpic, targetEpic]);
  const result = isLiveSessionInRoot(
    snap,
    "/repo",
    "work",
    "fn-1-foo.1",
    [],
    new Set(),
  );
  expect(result).toBe(false);
});

test("isLiveSessionInRoot — task.target_repo overrides epic.project_dir for effective root", () => {
  // A task with `target_repo: "/other-repo"` lives in /other-repo, NOT
  // the epic's /repo. A live session on that task must block dispatches
  // into /other-repo (not /repo). Mirrors the `taskCdDir` derivation
  // the dispatch sites use to compute `dirFull`.
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/other-repo",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/other-repo",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  // .2 dispatching into /other-repo MUST be blocked by .1's live job.
  expect(
    isLiveSessionInRoot(
      snap,
      "/other-repo",
      "work",
      "fn-1-foo.2",
      [],
      new Set(),
    ),
  ).toBe(true);
  // .2 dispatching into /repo (the epic's project_dir) would be a
  // mis-derived caller; the gate should NOT fire because no row's
  // effective root === /repo (.1 lives in /other-repo by target_repo).
  // This pins the "effective root" semantics — gate is not global.
  expect(
    isLiveSessionInRoot(snap, "/repo", "work", "fn-1-foo.2", [], new Set()),
  ).toBe(false);
});

test("isLiveSessionInRoot — fulfilled launch log entry does NOT count as live", () => {
  // A launch line whose key IS in `fulfilledKeys` is no longer "in
  // the propagation gap" — the embedded job has landed, so the
  // snapshot-driven branch is the source of truth. If the matching
  // row has since transitioned out of running (e.g. completed,
  // killed, idle) the row should not be blocked anymore. Without
  // this filter, every prior-run launch in `dispatch.log` would
  // pin its root forever.
  const dispatchLog: DispatchEntry[] = [
    makeDispatchEntry({
      verb: "work",
      id: "fn-1-foo.1",
      dir: "repo",
      dirFull: "/repo",
    }),
  ];
  const fulfilledKeys = new Set<string>(["work::fn-1-foo.1"]);
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      // .1's worker has finished (worker_phase=done, no live job).
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
      }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });
  const snap = buildSnap([epic]);
  // .2 dispatching into /repo should NOT be blocked.
  const result = isLiveSessionInRoot(
    snap,
    "/repo",
    "work",
    "fn-1-foo.2",
    dispatchLog,
    fulfilledKeys,
  );
  expect(result).toBe(false);
});

// ---------------------------------------------------------------------------
// validateShell — fn-640.1 $SHELL guard rules.
//
// Three independent rejection rules: undefined/empty, non-absolute,
// embedded `"`, and non-existent path. A passing absolute path that
// `existsSync` confirms is returned verbatim. The fallback at the
// call site is `/bin/zsh` — pinned via the `process.env.SHELL =
// undefined` case (returns null).
// ---------------------------------------------------------------------------

test("validateShell — undefined / empty / non-absolute / quote-injected / non-existent → null", () => {
  expect(validateShell(undefined)).toBe(null);
  expect(validateShell("")).toBe(null);
  expect(validateShell("zsh")).toBe(null); // not absolute
  expect(validateShell('/bin/zsh"')).toBe(null); // quote-injection guard
  expect(validateShell("/nonexistent/shell/path/xyzzy")).toBe(null);
});

test("validateShell — existing absolute path with no quote → returned verbatim", () => {
  // `/bin/sh` exists on every macOS / Linux box this repo runs on;
  // pinning it is the minimal positive case that exercises the
  // existsSync branch end-to-end.
  expect(validateShell("/bin/sh")).toBe("/bin/sh");
});

// ---------------------------------------------------------------------------
// fn-644 — startup-stagger gate. One-at-a-time over freshly-dispatched
// (launched but not yet running-tag) sessions. The gate is hardcoded
// to size 1 with no knob, no env override. Tests pin the five
// acceptance bullets: first-launch settles, second-while-occupied
// defers, drain-on-settle fires next, drain re-validation drops a now-
// mutex-blocked pending, and SETTLE_TIMEOUT_SEC fail-open.
// ---------------------------------------------------------------------------

function makePending(overrides: Partial<PendingLaunch>): PendingLaunch {
  return {
    verb: "work",
    id: "fn-1-foo.1",
    dir: "repo",
    dirFull: "/repo",
    command: "cd /repo && claude '/plan:work fn-1-foo.1'",
    rowId: "task fn-1-foo.1",
    tier: null,
    ...overrides,
  };
}

test("isSettlingGateFull — empty map allows any key (slot is free)", () => {
  const settling = new Map<string, number>();
  expect(isSettlingGateFull(settling, "work::fn-1-foo.1")).toBe(false);
});

test("isSettlingGateFull — occupied slot blocks a different key", () => {
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  expect(isSettlingGateFull(settling, "work::fn-1-foo.2")).toBe(true);
});

test("isSettlingGateFull — own key does not block itself", () => {
  // Self-re-edge must not deadlock: a key already in `settling` is
  // its own occupant; the gate returns false so a re-fire path could
  // run, but in practice `launchInGhostty`'s `dispatchedKeys` /
  // `fulfilledKeys` guards stop the re-launch upstream. The gate
  // here is dispatch-shape correctness only.
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  expect(isSettlingGateFull(settling, "work::fn-1-foo.1")).toBe(false);
});

test("tryLaunch — first call fires, leaves settling untouched (caller stamps slot)", () => {
  // The gate primitive routes through; the real `launchInGhostty`
  // stamps `settling.set` itself on the wet path. This test pins the
  // routing — pending is empty, the launch callback fires once, no
  // noteLine deferral is emitted.
  const settling = new Map<string, number>();
  const pendingLaunches = new Map<string, PendingLaunch>();
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  tryLaunch(
    makePending({}),
    settling,
    pendingLaunches,
    /*dryRun*/ false,
    (p) => fired.push(p),
    (s) => notes.push(s),
    42,
  );
  expect(fired.length).toBe(1);
  expect(fired[0]?.verb).toBe("work");
  expect(fired[0]?.id).toBe("fn-1-foo.1");
  expect(pendingLaunches.size).toBe(0);
  // No deferral note on the launch path.
  expect(notes.filter((s) => s.includes("settling-gate"))).toEqual([]);
});

test("tryLaunch — second call while slot occupied defers to pendingLaunches", () => {
  // Slot already held by a DIFFERENT key. The second ready row gets
  // stashed; no launch fires; a `settling-gate` deferral note is
  // emitted for the lifecycle sidecar.
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  const pendingLaunches = new Map<string, PendingLaunch>();
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  tryLaunch(
    makePending({ id: "fn-1-foo.2", rowId: "task fn-1-foo.2" }),
    settling,
    pendingLaunches,
    /*dryRun*/ false,
    (p) => fired.push(p),
    (s) => notes.push(s),
    42,
  );
  expect(fired).toEqual([]);
  expect(pendingLaunches.size).toBe(1);
  expect(pendingLaunches.get("work::fn-1-foo.2")?.id).toBe("fn-1-foo.2");
  // Deferral note carries the gate name + key + dirFull.
  expect(notes.some((s) => s.includes("settling-gate"))).toBe(true);
  expect(notes.some((s) => s.includes("work::fn-1-foo.2"))).toBe(true);
});

test("tryLaunch — dry-run bypasses the gate (gate is wet-only)", () => {
  // Mirror of the `paused` carve-out: dry-run never holds the slot
  // and never defers. The launch callback fires directly even when
  // `settling` has another occupant.
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  const pendingLaunches = new Map<string, PendingLaunch>();
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  tryLaunch(
    makePending({ id: "fn-1-foo.2" }),
    settling,
    pendingLaunches,
    /*dryRun*/ true,
    (p) => fired.push(p),
    (s) => notes.push(s),
    42,
  );
  expect(fired.length).toBe(1);
  expect(pendingLaunches.size).toBe(0);
  expect(notes).toEqual([]);
});

test("releaseSettledKeys — running-tag verdict frees the slot", () => {
  // settling holds the just-launched key; the snapshot has caught up
  // and observed the row at a running-tag verdict. The settle pass
  // frees the slot and notes the reason.
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
    ],
  });
  const snap = buildSnap([epic]);
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("running");
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  const notes: string[] = [];
  releaseSettledKeys(
    settling,
    snap,
    /*completedKeys*/ new Set(),
    (s) => notes.push(s),
    42,
  );
  expect(settling.size).toBe(0);
  expect(notes.some((s) => s.includes("reason=running"))).toBe(true);
  expect(notes.some((s) => s.includes("work::fn-1-foo.1"))).toBe(true);
});

test("releaseSettledKeys — completedKeys membership frees the slot", () => {
  // Jumped the running stage (disappearance branch in
  // `detectJobTransitions` migrated the key straight to
  // `completedKeys`). Settle pass still releases.
  const epic = makeEpic({ project_dir: "/repo" });
  const snap = buildSnap([epic]);
  const settling = new Map<string, number>([["approve::fn-1-foo", Date.now()]]);
  const notes: string[] = [];
  releaseSettledKeys(
    settling,
    snap,
    new Set<string>(["approve::fn-1-foo"]),
    (s) => notes.push(s),
    42,
  );
  expect(settling.size).toBe(0);
  expect(notes.some((s) => s.includes("reason=completed"))).toBe(true);
});

test("releaseSettledKeys — non-running, non-completed key stays in settling", () => {
  // Row is still in the propagation gap (no verdict yet, or
  // ready/blocked but not running). Slot stays held.
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  // Sanity: verdict is `ready`, NOT `running`.
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("ready");
  const settling = new Map<string, number>([["work::fn-1-foo.1", Date.now()]]);
  const notes: string[] = [];
  releaseSettledKeys(settling, snap, new Set(), (s) => notes.push(s), 42);
  expect(settling.size).toBe(1);
  expect(notes).toEqual([]);
});

test("sweepSettleTimeouts — entry older than SETTLE_TIMEOUT_SEC is fail-opened", () => {
  // The fail-open guard: a launch that never reached `running` is
  // dropped so the ramp can't wedge on a dead startup.
  const now = 1_000_000_000_000;
  const stale = now - (SETTLE_TIMEOUT_SEC + 1) * 1000;
  const fresh = now - 5_000;
  const settling = new Map<string, number>([
    ["work::fn-1-foo.1", stale],
    ["work::fn-1-foo.2", fresh],
  ]);
  const notes: string[] = [];
  sweepSettleTimeouts(settling, now, (s) => notes.push(s), 42);
  // Stale entry dropped; fresh entry preserved.
  expect(settling.has("work::fn-1-foo.1")).toBe(false);
  expect(settling.has("work::fn-1-foo.2")).toBe(true);
  expect(notes.some((s) => s.includes("settling timeout"))).toBe(true);
  expect(notes.some((s) => s.includes("work::fn-1-foo.1"))).toBe(true);
});

test("drainPendingLaunches — fires the oldest pending entry when slot frees", () => {
  // The drain-on-settle fix. Slot is free, two entries are queued in
  // insertion order; the drain pops the oldest, re-validates against
  // the current snap (still ready, gate still clear), and fires the
  // launch. The launch callback stamps `settling.set` (mirroring
  // production's `launchInGhostty`) so the gate re-closes after the
  // first fire and the second entry stays put. Two independent
  // epics in DIFFERENT roots avoid the readiness-side per-epic /
  // per-root mutex (predicates 11/12) so both rows can sit at
  // `ready` simultaneously — the gate under test is autopilot's
  // own one-at-a-time slot, not the readiness mutexes.
  const epicA = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        epic_id: "fn-1-foo",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
      }),
    ],
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo-b",
    tasks: [
      makeTask({
        task_id: "fn-2-bar.1",
        epic_id: "fn-2-bar",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
      }),
    ],
  });
  const snap = buildSnap([epicA, epicB]);
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("ready");
  expect(snap.readiness.perTask.get("fn-2-bar.1")?.tag).toBe("ready");
  const settling = new Map<string, number>();
  const pendingLaunches = new Map<string, PendingLaunch>([
    ["work::fn-1-foo.1", makePending({ id: "fn-1-foo.1", dirFull: "/repo-a" })],
    ["work::fn-2-bar.1", makePending({ id: "fn-2-bar.1", dirFull: "/repo-b" })],
  ]);
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  const fireLaunch = (p: PendingLaunch): void => {
    fired.push(p);
    // Mirror production: `launchInGhostty` stamps `settling.set` on
    // the real-launch path.
    settling.set(`${p.verb}::${p.id}`, Date.now());
  };
  drainPendingLaunches(
    snap,
    settling,
    pendingLaunches,
    /*dispatchedKeys*/ new Set(),
    /*fulfilledKeys*/ new Set(),
    /*dispatchLog*/ [],
    fireLaunch,
    (s) => notes.push(s),
    42,
  );
  expect(fired.length).toBe(1);
  expect(fired[0]?.id).toBe("fn-1-foo.1");
  // Second entry still pending after the slot re-closed.
  expect(pendingLaunches.has("work::fn-2-bar.1")).toBe(true);
  expect(pendingLaunches.has("work::fn-1-foo.1")).toBe(false);
});

test("drainPendingLaunches — discards a pending entry whose verdict moved off ready", () => {
  // Pending was queued at the ready edge; by drain time the snapshot
  // shows the row at a different verdict. Drop the entry; do not
  // fire. (Re-edge would re-queue if the row becomes ready again.)
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        // worker_phase=done + no jobs + approval=pending → blocked:job-pending
        worker_phase: "done",
        approval: "pending",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("blocked");
  const settling = new Map<string, number>();
  const pendingLaunches = new Map<string, PendingLaunch>([
    ["work::fn-1-foo.1", makePending({ verb: "work", id: "fn-1-foo.1" })],
  ]);
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  drainPendingLaunches(
    snap,
    settling,
    pendingLaunches,
    new Set(),
    new Set(),
    [],
    (p) => fired.push(p),
    (s) => notes.push(s),
    42,
  );
  expect(fired).toEqual([]);
  expect(pendingLaunches.size).toBe(0);
  expect(notes.some((s) => s.includes("pending discarded"))).toBe(true);
  expect(notes.some((s) => s.includes("verdict-"))).toBe(true);
});

test("drainPendingLaunches — discards a pending entry now blocked by the per-root mutex", () => {
  // The duplicate-race fix. Pending was queued at the original
  // ready edge for .2 while the slot was held by another launch;
  // by drain time .1 in the same root has gone to `running` and
  // the readiness-side per-epic mutex (predicate 11) has demoted
  // .2 to `blocked:single-task-per-epic`. Re-validation against
  // the current snap drops the held duplicate so we never spawn
  // the second worker — the exact race the epic was filed against
  // (a `work::N+1` slipping past both the readiness mutex and the
  // autopilot `live-in-root` gate on a transient stopped frame).
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        worker_phase: "open",
        approval: "approved",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  // .1 is running, so the readiness mutex (predicate 11) demotes
  // .2 from `ready` to `blocked:single-task-per-epic`. The drain's
  // verdict re-check catches it.
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("running");
  expect(snap.readiness.perTask.get("fn-1-foo.2")?.tag).toBe("blocked");
  const settling = new Map<string, number>();
  const pendingLaunches = new Map<string, PendingLaunch>([
    ["work::fn-1-foo.2", makePending({ verb: "work", id: "fn-1-foo.2" })],
  ]);
  const fired: PendingLaunch[] = [];
  const notes: string[] = [];
  drainPendingLaunches(
    snap,
    settling,
    pendingLaunches,
    /*dispatchedKeys*/ new Set(),
    /*fulfilledKeys*/ new Set(),
    /*dispatchLog*/ [],
    (p) => fired.push(p),
    (s) => notes.push(s),
    42,
  );
  expect(fired).toEqual([]);
  expect(pendingLaunches.size).toBe(0);
  expect(notes.some((s) => s.includes("pending discarded"))).toBe(true);
  // Re-validation drops on the verdict re-check (the readiness
  // mutex demoted the row). The autopilot-side `live-in-root`
  // backstop also covers the propagation-gap variant of the same
  // race (covered in `shouldSuppressDispatch` tests above).
  expect(notes.some((s) => s.includes("verdict-blocked"))).toBe(true);
});

test("drainPendingLaunches — returns early when slot is already occupied", () => {
  // No drain happens while the slot is held; the entry stays queued.
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "approved",
      }),
    ],
  });
  const snap = buildSnap([epic]);
  const settling = new Map<string, number>([["work::fn-1-foo.9", Date.now()]]);
  const pendingLaunches = new Map<string, PendingLaunch>([
    ["work::fn-1-foo.1", makePending({ id: "fn-1-foo.1" })],
  ]);
  const fired: PendingLaunch[] = [];
  drainPendingLaunches(
    snap,
    settling,
    pendingLaunches,
    new Set(),
    new Set(),
    [],
    (p) => fired.push(p),
    () => {},
    42,
  );
  expect(fired).toEqual([]);
  expect(pendingLaunches.size).toBe(1);
});
