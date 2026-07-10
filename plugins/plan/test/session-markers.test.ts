// Conformance spec for the session-marker layer — translated from
// tests/test_session_markers.py, every inventory node mapped by a source-comment
// (translated | cited | drop-with-reason). 28 inventory nodes.
//
// The marker file is one JSON per session at
// <HOME>/.local/state/keeper/sessions/<sid>.json (schema_version 1). Every CLI
// call here pins CLAUDE_CODE_SESSION_ID to a fixed value via `cli()`, so the
// writer side (claim / worker resume write a work marker; done / block /
// close-finalize clear a matching one; close-preflight writes a close marker) is
// CLI-observable by reading that file under the per-test tmp HOME.
//
// Drop boundary (the judgment seam — enumerated explicitly so the gate's
// spot-audit can verify it): the in-process HELPER-SPY nodes drop as python_only
// (they monkeypatch session_markers internals — _sessions_dir, Path.mkdir,
// Path.unlink — seams the subprocess cannot expose); the CLI-OBSERVABLE marker
// behavior translates. The READER-side read_marker nodes (roundtrip, missing,
// stale-unlink, fresh-kept, corrupt-unlink, non-dict-unlink) are CITED to
// test/lib.test.ts, which owns the readMarker port (the bun writer-side
// session_markers.ts deliberately has no reader — that lives in plugin/hooks/lib).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CliResult,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  seedRuntime,
  withProject,
} from "./harness.ts";

const SID = "test-marker-session"; // pinned per CLI call so markers are observable.

interface Proj {
  root: string;
  home: string;
}

// Every CLI call routes through here so the session id is pinned (the harness
// otherwise forwards the ambient CLAUDE_CODE_SESSION_ID, which would scatter the
// marker filename across runs).
function cli(args: string[], proj: Proj): CliResult {
  return runCli(args, {
    cwd: proj.root,
    home: proj.home,
    env: { CLAUDE_CODE_SESSION_ID: SID },
  });
}

function markerFile(home: string): string {
  return join(home, ".local", "state", "keeper", "sessions", `${SID}.json`);
}

function markerPresent(home: string): boolean {
  return existsSync(markerFile(home));
}

function readMarker(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(markerFile(home), "utf-8"));
}

function scaffold(
  proj: Proj,
  title: string,
  nTasks = 1,
): { epicId: string; taskIds: string[] } {
  return scaffoldEpic(
    { root: proj.root, home: proj.home },
    { title, nTasks, env: { CLAUDE_CODE_SESSION_ID: SID } },
  );
}

// In-process helper unit nodes — CITED, not re-translated. -------------------
// test_session_markers.py::test_read_marker_roundtrip
//   -> CITED lib.test.ts "reads a fresh work marker honoring the schema-1 fields".
// test_session_markers.py::test_read_marker_missing_returns_none
//   -> CITED lib.test.ts "returns null for an absent marker".
// test_session_markers.py::test_read_marker_unlinks_stale
//   -> CITED lib.test.ts "unlinks and returns null for a marker older than 7 days".
// test_session_markers.py::test_read_marker_fresh_kept
//   -> CITED lib.test.ts "reads a fresh work marker ..." (a just-written marker is
//      under the 7-day window and survives the read).
// test_session_markers.py::test_read_marker_corrupt_unlinks
//   -> CITED lib.test.ts "returns null for unparseable JSON without throwing".
// test_session_markers.py::test_read_marker_non_dict_unlinks
//   -> CITED lib.test.ts "unlinks and returns null for a non-object marker".
//
// python_only DROPS (in-process helper-spies; no subprocess-observable surface):
// test_session_markers.py::test_no_env_is_noop_for_every_helper
//   -> DROP python_only: monkeypatches _sessions_dir and asserts the dir is never
//      created when CLAUDE_CODE_SESSION_ID is unset. The fail-open no-op is an
//      internal helper contract; a subprocess writes its marker to its own HOME,
//      which the in-process _sessions_dir monkeypatch cannot redirect.
// test_session_markers.py::test_write_io_error_swallowed
//   -> DROP python_only: monkeypatches session_markers.Path.mkdir to raise — a
//      Python-internal injection with no CLI seam.
// test_session_markers.py::test_clear_io_error_swallowed
//   -> DROP python_only: monkeypatches session_markers.Path.unlink to raise — a
//      Python-internal injection with no CLI seam.
// test_session_markers.py::test_claim_success_writes_work_marker
//   -> DROP python_only: explicitly @pytest.mark.python_only. The assertion reads
//      the in-process _sessions_dir monkeypatch target; under a subprocess the
//      claim writes to its own HOME, which the monkeypatch cannot redirect. The
//      CLI-observable write-work-marker behavior is covered by "claim writes a
//      work marker" below (driven via --project, observed on disk).

// Claim a task to plant a work marker; returns {epicId, taskIds}.
function claimFirst(
  proj: Proj,
  nTasks = 1,
): { epicId: string; taskIds: string[] } {
  const { epicId, taskIds } = scaffold(proj, "Marker epic", nTasks);
  const r = cli(["claim", taskIds[0] as string, "--project", proj.root], proj);
  expect(r.code).toBe(0);
  return { epicId, taskIds };
}

// Mark every task done and run close-preflight (which plants the close marker);
// returns the epic id. Distinct titles avoid scaffold's duplicate-slug guard.
function preflightReady(proj: Proj, title: string): string {
  const { epicId, taskIds } = scaffold(proj, title, 1);
  for (const tid of taskIds) {
    seedRuntime(proj.root, tid, { status: "done" });
  }
  const pf = cli(["close-preflight", epicId, "--project", proj.root], proj);
  expect(pf.code).toBe(0);
  return epicId;
}

describe("marker writer schema", () => {
  const getProj = withProject("keeper-plan-marker-write-");

  // test_session_markers.py::test_write_work_marker_schema
  test("claim writes a schema-1 work marker naming the task", () => {
    const proj = getProj();
    const { taskIds } = claimFirst(proj);
    const rec = readMarker(proj.home);
    expect(rec.schema_version).toBe(1);
    expect(rec.session_id).toBe(SID);
    expect(rec.kind).toBe("work");
    expect(rec.task_id).toBe(taskIds[0]);
    expect(typeof rec.created_at).toBe("string");
    expect((rec.created_at as string).length).toBeGreaterThan(0);
  });

  test("a tracked Pi job owns its work marker", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffold(proj, "Pi marker epic");
    expect(cli(["validate", "--epic", epicId], proj).code).toBe(0);
    const claimed = runCli(
      ["claim", taskIds[0] as string, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: "", KEEPER_JOB_ID: "pi-job" },
      },
    );
    expect(claimed.code).toBe(0);
    const path = join(
      proj.home,
      ".local",
      "state",
      "keeper",
      "sessions",
      "pi-job.json",
    );
    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec.session_id).toBe("pi-job");
    expect(rec.task_id).toBe(taskIds[0]);
  });

  // test_session_markers.py::test_write_close_marker_schema
  test("close-preflight writes a schema-1 close marker carrying epic_id", () => {
    const proj = getProj();
    const epicId = preflightReady(proj, "Close marker epic");
    const rec = readMarker(proj.home);
    expect(rec.schema_version).toBe(1);
    expect(rec.session_id).toBe(SID);
    expect(rec.kind).toBe("close");
    expect(rec.epic_id).toBe(epicId);
    expect("task_id" in rec).toBe(false);
  });
});

describe("work-marker clear-if-matches", () => {
  const getProj = withProject("keeper-plan-marker-clear-");

  // test_session_markers.py::test_clear_work_marker_matching +
  // test_session_markers.py::test_done_clears_matching_work_marker
  test("done clears the matching work marker", () => {
    const proj = getProj();
    const { taskIds } = claimFirst(proj);
    expect(markerPresent(proj.home)).toBe(true);
    const r = cli(["done", taskIds[0] as string, "--summary", "shipped"], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(false);
  });

  // test_session_markers.py::test_clear_work_marker_mismatch_left_intact +
  // test_session_markers.py::test_done_leaves_mismatched_marker
  test("done leaves a marker naming a different task intact", () => {
    const proj = getProj();
    const { taskIds } = claimFirst(proj, 2);
    // Re-point the marker at task .2 (last claim wins the marker).
    const r2 = cli(
      ["claim", taskIds[1] as string, "--project", proj.root],
      proj,
    );
    expect(r2.code).toBe(0);
    expect(readMarker(proj.home).task_id).toBe(taskIds[1]);
    // done on .1 must NOT clear the .2 marker (the .1 sidecar is in_progress
    // from its own claim, so done succeeds).
    const r = cli(["done", taskIds[0] as string, "--summary", "x"], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(true);
    expect(readMarker(proj.home).task_id).toBe(taskIds[1]);
  });

  // test_session_markers.py::test_block_clears_matching_work_marker
  test("block clears the matching work marker", () => {
    const proj = getProj();
    const { taskIds } = claimFirst(proj);
    expect(markerPresent(proj.home)).toBe(true);
    const r = cli(["block", taskIds[0] as string, "--reason", "stuck"], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(false);
  });

  // test_session_markers.py::test_clear_kind_crosswise_is_mismatch — done's
  // clearWorkMarker keys on task_id; a close marker has none, so a done call does
  // NOT clear it.
  test("done does not clear a close marker (crosswise kind mismatch)", () => {
    const proj = getProj();
    // Plant a CLOSE marker via a ready epic's preflight.
    const epicId = preflightReady(proj, "Crosswise epic");
    expect(readMarker(proj.home).kind).toBe("close");
    const taskId = `${epicId}.1`;
    // Re-seed the task in_progress so the done call itself succeeds.
    seedRuntime(proj.root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    const r = cli(["done", taskId, "--summary", "x"], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(true);
    expect(readMarker(proj.home).kind).toBe("close");
  });
});

describe("close-marker clear via close-finalize", () => {
  const getProj = withProject("keeper-plan-marker-finalize-");

  // test_session_markers.py::test_clear_close_marker_matching +
  // test_session_markers.py::test_close_finalize_clears_marker_on_every_outcome[closed_clean] +
  // test_session_markers.py::test_close_finalize_clears_marker_on_every_outcome[closed_with_followup] +
  // test_session_markers.py::test_close_finalize_clears_marker_on_every_outcome[fatal_halt] +
  // test_session_markers.py::test_close_finalize_clears_marker_on_every_outcome[partial_followup]
  //   — the single _emit_outcome chokepoint clears the close marker when it names
  // the epic, on EVERY terminal outcome. The closed_clean path drives the
  // chokepoint end-to-end through the binary; the other three outcome params share
  // the identical clearCloseMarker(epicId) call at the same single chokepoint (the
  // verb has one clear site, not per-outcome sites — one CLI drive covers the set).
  test("close-finalize clears the matching close marker (closed_clean)", () => {
    const proj = getProj();
    const epicId = preflightReady(proj, "Finalize clean epic");
    expect(readMarker(proj.home).kind).toBe("close");
    const sub = runCli(
      ["verdict", "submit", epicId, "--file", "-", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: SID },
        input: JSON.stringify({
          fatal: false,
          fatal_reason: "",
          decisions: [],
        }),
      },
    );
    expect(sub.code).toBe(0);
    const r = cli(["close-finalize", epicId, "--project", proj.root], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(false);
  });

  // test_session_markers.py::test_clear_close_marker_mismatch_left_intact +
  // test_session_markers.py::test_close_finalize_leaves_mismatched_marker — a
  // close marker naming a DIFFERENT epic survives close-finalize.
  test("close-finalize leaves a close marker naming a different epic intact", () => {
    const proj = getProj();
    // Stand up two ready epics; finalize B while the marker names A.
    const epicA = preflightReady(proj, "Finalize keep A");
    const epicB = preflightReady(proj, "Finalize close B"); // marker now names B
    // Re-plant A's marker (last preflight wins).
    const reA = cli(["close-preflight", epicA, "--project", proj.root], proj);
    expect(reA.code).toBe(0);
    expect(readMarker(proj.home).epic_id).toBe(epicA);
    const subB = runCli(
      ["verdict", "submit", epicB, "--file", "-", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: SID },
        input: JSON.stringify({
          fatal: false,
          fatal_reason: "",
          decisions: [],
        }),
      },
    );
    expect(subB.code).toBe(0);
    const r = cli(["close-finalize", epicB, "--project", proj.root], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(true);
    expect(readMarker(proj.home).epic_id).toBe(epicA);
  });
});

describe("marker write-nothing on the error path", () => {
  const getProj = withProject("keeper-plan-marker-noop-");

  // test_session_markers.py::test_claim_typed_error_writes_nothing
  test("a bad-task-id claim writes no marker", () => {
    const proj = getProj();
    const r = cli(["claim", "not-a-task-id", "--project", proj.root], proj);
    expect(r.code).not.toBe(0);
    expect(markerPresent(proj.home)).toBe(false);
  });

  // test_session_markers.py::test_close_preflight_failure_writes_no_close_marker
  test("a not-ready close-preflight writes no close marker", () => {
    const proj = getProj();
    const { epicId } = scaffold(proj, "Not ready epic", 1);
    // Task left open -> NOT_READY before the marker write.
    const r = cli(["close-preflight", epicId, "--project", proj.root], proj);
    expect(r.code).not.toBe(0);
    expect(markerPresent(proj.home)).toBe(false);
  });
});

describe("worker resume marker", () => {
  const getProj = withProject("keeper-plan-marker-resume-");

  // test_session_markers.py::test_worker_resume_success_writes_work_marker
  test("worker resume writes the work marker", () => {
    const proj = getProj();
    const { taskIds } = scaffold(proj, "Resume epic", 1);
    const taskId = taskIds[0] as string;
    // An in_progress sidecar so resume's success path (re-emit + marker) runs.
    seedRuntime(proj.root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    const r = cli(["worker", "resume", taskId, "--project", proj.root], proj);
    expect(r.code).toBe(0);
    expect(markerPresent(proj.home)).toBe(true);
    expect(readMarker(proj.home).task_id).toBe(taskId);
  });
});

// close-preflight's claim step asserts exclusivity across sessions: the first
// claimant holds the epic, a second concurrent one fails loud with a typed
// CLOSE_ALREADY_CLAIMED. Two distinct session ids under ONE home make the rival
// marker observable.
describe("close-claim exclusivity (fail-loud loser)", () => {
  const getProj = withProject("keeper-plan-close-claim-");

  const SID_A = "close-session-a";
  const SID_B = "close-session-b";

  function preflight(proj: Proj, epicId: string, sid: string): CliResult {
    return runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: sid },
    });
  }

  function markerFor(home: string, sid: string): string {
    return join(home, ".local", "state", "keeper", "sessions", `${sid}.json`);
  }

  // A single-task epic with its task done — ready to close.
  function readyEpic(proj: Proj, title: string): string {
    const { epicId, taskIds } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title, nTasks: 1, env: { CLAUDE_CODE_SESSION_ID: SID_A } },
    );
    for (const tid of taskIds) {
      seedRuntime(proj.root, tid, { status: "done" });
    }
    return epicId;
  }

  test("a second concurrent close claim fails loud; the first is unaffected", () => {
    const proj = getProj();
    const epicId = readyEpic(proj, "Exclusive close epic");

    // Session A claims first — succeeds and holds the marker.
    const a = preflight(proj, epicId, SID_A);
    expect(a.code).toBe(0);
    expect(existsSync(markerFor(proj.home, SID_A))).toBe(true);

    // Session B races the same epic — loses, fails loud with the typed
    // CLOSE_ALREADY_CLAIMED error, and leaves no marker of its own.
    const b = preflight(proj, epicId, SID_B);
    expect(b.code).not.toBe(0);
    const env = parseCliOutput(b.output);
    expect(env.success).toBe(false);
    const error = env.error as {
      code: string;
      details?: Record<string, unknown>;
    };
    expect(error.code).toBe("CLOSE_ALREADY_CLAIMED");
    expect(error.details?.held_by_session).toBe(SID_A);
    expect(existsSync(markerFor(proj.home, SID_B))).toBe(false);

    // A's claim survives B's failed attempt.
    expect(existsSync(markerFor(proj.home, SID_A))).toBe(true);
  });

  test("the same session re-running preflight re-claims its own epic (no self-block)", () => {
    const proj = getProj();
    const epicId = readyEpic(proj, "Self reclaim epic");
    expect(preflight(proj, epicId, SID_A).code).toBe(0);
    // A second preflight from the SAME session must not treat its own marker as
    // a rival — it re-claims cleanly.
    expect(preflight(proj, epicId, SID_A).code).toBe(0);
    expect(existsSync(markerFor(proj.home, SID_A))).toBe(true);
  });

  test("a finalize error releases the claim (so a re-close is never jammed)", () => {
    const proj = getProj();
    const epicId = readyEpic(proj, "Finalize error release epic");
    expect(preflight(proj, epicId, SID_A).code).toBe(0);
    expect(existsSync(markerFor(proj.home, SID_A))).toBe(true);
    // Finalize with no verdict/report submitted -> a typed error, which MUST
    // release the claim: a leaked marker would jam every re-run's preflight with
    // CLOSE_ALREADY_CLAIMED.
    const fin = runCli(["close-finalize", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: SID_A },
    });
    expect(fin.code).not.toBe(0);
    expect(existsSync(markerFor(proj.home, SID_A))).toBe(false);
  });
});
