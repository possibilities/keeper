/**
 * restore-verify — the per-tab VERIFIED restore transaction.
 *
 * Fast-tier, pure over injected seams (no tmux, no daemon, no real clock): the
 * durable intent artifact round-trip + torn/version guards, the on-disk attach
 * evidence readers (claude NDJSON + non-claude birth record, recency-gated), the
 * pane-liveness classifier, the bounded verification state matrix, the crash-loop
 * bound, and the advisory apply flock (a second concurrent holder is a no-op).
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplyLockIdentity,
  type AttachIdentity,
  classifyPaneLiveness,
  claudeAttachEvidence,
  completeLines,
  crashLoopHint,
  gcRestoreIntents,
  identityLiveness,
  listOpenRestoreIntents,
  listRestoreIntents,
  mayAttemptRestore,
  nonClaudeAttachEvidence,
  parseRestoreIntent,
  RESTORE_AUTO_ATTEMPT_CAP,
  RESTORE_INTENT_SCHEMA_VERSION,
  type RestoreIntent,
  type RestoreIntentState,
  readRestoreIntent,
  restoreNoOpDecision,
  type StartTimeProbeDeps,
  tryAcquireApplyLock,
  verifyAttach,
  writeRestoreIntent,
} from "../src/restore-verify";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function intent(over: Partial<RestoreIntent> = {}): RestoreIntent {
  return {
    schema_version: RESTORE_INTENT_SCHEMA_VERSION,
    generation_id: "gen-1",
    job_id: "job-1",
    session_uuid: "sess-uuid-1",
    harness: "claude",
    resume_target: "sess-uuid-1",
    cwd: "/repo",
    backend_exec_session_id: "work",
    argv: ["keeper", "agent", "claude", "--resume", "sess-uuid-1"],
    rerun_command:
      "keeper tabs restore --apply --generation gen-1 --session work",
    attempt: 1,
    state: "planned",
    reason: "",
    verified_pid: null,
    verified_start_time: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    ...over,
  };
}

/** One events-log NDJSON line for a SessionStart on `sessionId` at `tsSecs`. The
 *  `pid` / `start_time` recycle-safe identity the hook stamps on SessionStart is
 *  carried so the evidence reader can lift it (defaults mirror a real record). */
function sessionStartLine(
  sessionId: string,
  tsSecs: number,
  identity: { pid?: number | null; start_time?: string | null } = {},
): string {
  const pid = "pid" in identity ? identity.pid : 7777;
  const startTime =
    "start_time" in identity ? identity.start_time : "darwin:start-7777";
  return `${JSON.stringify({
    bindings: {
      ts: tsSecs,
      session_id: sessionId,
      hook_event: "SessionStart",
      event_type: "session_start",
      pid,
      start_time: startTime,
    },
  })}\n`;
}

/** One birth-record file body carrying `sessionId` (== keeper job id), with the
 *  recycle-safe `(pid, start_time)` the launcher stamps. */
function birthBody(
  sessionId: string,
  launchIso: string,
  identity: { pid?: number; start_time?: string | null } = {},
): string {
  return `${JSON.stringify({
    schema_version: 1,
    session_id: sessionId,
    harness: "pi",
    pid: identity.pid ?? 4242,
    start_time: "start_time" in identity ? identity.start_time : "linux:990099",
    cwd: "/repo",
    spawn_name: null,
    config_dir: null,
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
    worktree: null,
    launch_ts: launchIso,
    resume_target: null,
  })}\n`;
}

// ---------------------------------------------------------------------------
// Intent artifact — write/read round-trip, parse guards, list, GC
// ---------------------------------------------------------------------------

describe("restore intent artifact", () => {
  test("write then read round-trips the intent (0600, atomic)", () => {
    const dir = tmp("rv-intent-");
    const i = intent({ session_uuid: "abc-123" });
    writeRestoreIntent(dir, i);
    const back = readRestoreIntent(dir, {
      generation_id: i.generation_id,
      session_uuid: i.session_uuid,
      job_id: i.job_id,
    });
    expect(back).toEqual(i);
  });

  test("round-trips a verified intent's (pid, start_time) handle", () => {
    const dir = tmp("rv-intent-");
    const i = intent({
      state: "verified",
      verified_pid: 9090,
      verified_start_time: "darwin:handle",
    });
    writeRestoreIntent(dir, i);
    const back = readRestoreIntent(dir, {
      generation_id: i.generation_id,
      session_uuid: i.session_uuid,
      job_id: i.job_id,
    });
    expect(back?.verified_pid).toBe(9090);
    expect(back?.verified_start_time).toBe("darwin:handle");
  });

  test("parseRestoreIntent accepts a pre-handle intent, defaulting the handle to null", () => {
    // Backward-compat: an intent written before the (pid, start_time) handle
    // existed omits the fields entirely — it must still parse (never a rejected
    // record forcing a rewind), reading as an unprobeable handle.
    const { verified_pid, verified_start_time, ...legacy } = intent({
      state: "verified",
    });
    void verified_pid;
    void verified_start_time;
    expect("verified_pid" in legacy).toBe(false);
    const parsed = parseRestoreIntent(JSON.stringify(legacy));
    expect(parsed).not.toBeNull();
    expect(parsed?.verified_pid).toBeNull();
    expect(parsed?.verified_start_time).toBeNull();
  });

  test("parseRestoreIntent rejects a present-but-mistyped handle", () => {
    const bad = JSON.stringify({ ...intent(), verified_pid: "not-a-number" });
    expect(parseRestoreIntent(bad)).toBeNull();
  });

  test("parseRestoreIntent rejects a wrong schema_version", () => {
    const bad = JSON.stringify({ ...intent(), schema_version: 999 });
    expect(parseRestoreIntent(bad)).toBeNull();
  });

  test("parseRestoreIntent rejects a torn / partial line", () => {
    const whole = `${JSON.stringify(intent())}\n`;
    // Truncate mid-JSON — a killed writer's partial must never fold.
    expect(parseRestoreIntent(whole.slice(0, whole.length / 2))).toBeNull();
    expect(parseRestoreIntent("")).toBeNull();
    expect(parseRestoreIntent("   ")).toBeNull();
  });

  test("parseRestoreIntent rejects a non-integer attempt", () => {
    const bad = JSON.stringify({ ...intent(), attempt: 1.5 });
    expect(parseRestoreIntent(bad)).toBeNull();
  });

  test("readRestoreIntent returns null for an absent key", () => {
    const dir = tmp("rv-intent-");
    expect(
      readRestoreIntent(dir, {
        generation_id: "nope",
        session_uuid: "nope",
        job_id: "nope",
      }),
    ).toBeNull();
  });

  test("listOpenRestoreIntents surfaces only the resurface-worthy states", () => {
    const dir = tmp("rv-intent-");
    const states: RestoreIntentState[] = [
      "planned",
      "launched",
      "verified",
      "failed",
      "launched-unverified",
      "preflight_failed",
    ];
    states.forEach((state, n) => {
      writeRestoreIntent(
        dir,
        intent({ session_uuid: `s-${n}`, job_id: `j-${n}`, state }),
      );
    });
    const open = listOpenRestoreIntents(dir)
      .map((i) => i.state)
      .sort();
    // planned / launched (transient) and verified (cleared) never resurface.
    expect(open).toEqual(["failed", "launched-unverified", "preflight_failed"]);
  });

  test("gcRestoreIntents sweeps only files past the idle cutoff", () => {
    const dir = tmp("rv-intent-");
    writeRestoreIntent(dir, intent({ session_uuid: "fresh", job_id: "jf" }));
    writeRestoreIntent(dir, intent({ session_uuid: "stale", job_id: "js" }));
    const stalePath = join(dir, "gen-1.stale.json");
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60; // 30d ago, in seconds
    utimesSync(stalePath, old, old);
    const swept = gcRestoreIntents(dir, Date.now());
    expect(swept).toBe(1);
    expect(listRestoreIntents(dir).map((i) => i.session_uuid)).toEqual([
      "fresh",
    ]);
  });
});

// ---------------------------------------------------------------------------
// completeLines — torn-tail contract
// ---------------------------------------------------------------------------

describe("completeLines", () => {
  test("returns whole lines and drops a trailing partial", () => {
    expect(completeLines("a\nb\nhalf")).toEqual(["a", "b"]);
  });

  test("no newline at all yields no complete lines", () => {
    expect(completeLines("nopartial终")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// claude attach evidence — SessionStart for the exact id, recency-gated
// ---------------------------------------------------------------------------

describe("claudeAttachEvidence", () => {
  test("returns the SessionStart's (pid, start_time) for the exact session id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(
      join(dir, "111.ndjson"),
      sessionStartLine("wanted", 1000, { pid: 5150, start_time: "darwin:x" }),
    );
    expect(claudeAttachEvidence(dir, "wanted")).toEqual({
      pid: 5150,
      start_time: "darwin:x",
    });
  });

  test("a matched record missing pid/start_time yields a null-handle identity", () => {
    const dir = tmp("rv-events-");
    writeFileSync(
      join(dir, "111.ndjson"),
      sessionStartLine("wanted", 1000, { pid: null, start_time: null }),
    );
    // Evidence WAS seen (attach proven) but the identity is unprobeable.
    expect(claudeAttachEvidence(dir, "wanted")).toEqual({
      pid: null,
      start_time: null,
    });
  });

  test("null for a SessionStart of a DIFFERENT session id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(join(dir, "111.ndjson"), sessionStartLine("other", 1000));
    expect(claudeAttachEvidence(dir, "wanted")).toBeNull();
  });

  test("null for a non-SessionStart event on the same id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(
      join(dir, "111.ndjson"),
      `${JSON.stringify({
        bindings: { ts: 1000, session_id: "wanted", hook_event: "Stop" },
      })}\n`,
    );
    expect(claudeAttachEvidence(dir, "wanted")).toBeNull();
  });

  test("a torn final line is never consumed as evidence", () => {
    const dir = tmp("rv-events-");
    // The matching SessionStart is the trailing PARTIAL (no newline) → not read.
    const partial = sessionStartLine("wanted", 1000).replace(/\n$/, "");
    writeFileSync(join(dir, "111.ndjson"), `noise\n${partial}`);
    expect(claudeAttachEvidence(dir, "wanted")).toBeNull();
  });

  test("recency gate rejects a STALE pre-crash SessionStart", () => {
    const dir = tmp("rv-events-");
    // Event at t=1000s (1_000_000 ms); floor at 2_000_000 ms → rejected.
    writeFileSync(join(dir, "111.ndjson"), sessionStartLine("wanted", 1000));
    expect(claudeAttachEvidence(dir, "wanted", 2_000_000)).toBeNull();
    // A fresh event at t=3000s (3_000_000 ms) clears the same floor.
    writeFileSync(
      join(dir, "222.ndjson"),
      sessionStartLine("wanted", 3000, {
        pid: 3003,
        start_time: "darwin:fresh",
      }),
    );
    expect(claudeAttachEvidence(dir, "wanted", 2_000_000)).toEqual({
      pid: 3003,
      start_time: "darwin:fresh",
    });
  });

  test("empty session id and absent dir are both no-evidence", () => {
    const dir = tmp("rv-events-");
    expect(claudeAttachEvidence(dir, "")).toBeNull();
    expect(claudeAttachEvidence(join(dir, "nope"), "wanted")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// non-claude attach evidence — birth record on the carried job id
// ---------------------------------------------------------------------------

describe("nonClaudeAttachEvidence", () => {
  test("returns the birth record's (pid, start_time) for the job id", () => {
    const dir = tmp("rv-birth-");
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(
      join(dir, "new", "4242.rec.json"),
      birthBody("job-x", "2026-07-07T01:00:00.000Z", {
        pid: 8080,
        start_time: "linux:424242",
      }),
    );
    expect(nonClaudeAttachEvidence(dir, "job-x")).toEqual({
      pid: 8080,
      start_time: "linux:424242",
    });
    expect(nonClaudeAttachEvidence(dir, "job-other")).toBeNull();
  });

  test("recency gate rejects a stale birth record", () => {
    const dir = tmp("rv-birth-");
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(
      join(dir, "new", "4242.rec.json"),
      birthBody("job-x", "2026-07-07T00:00:00.000Z"),
    );
    const floor = Date.parse("2026-07-07T02:00:00.000Z");
    expect(nonClaudeAttachEvidence(dir, "job-x", floor)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pane liveness classifier
// ---------------------------------------------------------------------------

describe("classifyPaneLiveness", () => {
  test("pane_dead=1 is dead regardless of command", () => {
    expect(classifyPaneLiveness("1", "claude")).toBe("dead");
  });

  test("a live pane running a login-shell tail is dead (harness exited)", () => {
    expect(classifyPaneLiveness("0", "zsh")).toBe("dead");
    expect(classifyPaneLiveness("0", "-bash")).toBe("dead");
  });

  test("a live pane running the harness is alive", () => {
    expect(classifyPaneLiveness("0", "claude")).toBe("alive");
    expect(classifyPaneLiveness("0", "pi")).toBe("alive");
  });

  test("an empty current command is unknown", () => {
    expect(classifyPaneLiveness("0", "")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// verifyAttach — the evidence window + dwell state matrix
// ---------------------------------------------------------------------------

const ID: AttachIdentity = { pid: 4242, start_time: "darwin:s" };
/** A fixed clock + no-op sleep. The dwell is POLL-COUNT bounded, so a stopped
 *  clock cannot spin it. */
const fixedClock = { now: () => 0, sleep: async () => {} };

describe("verifyAttach", () => {
  test("evidence present + process stays alive across the dwell → verified", async () => {
    let paneProbed = false;
    const result = await verifyAttach({
      findEvidence: () => ID,
      identityLiveness: () => "alive",
      paneLiveness: () => {
        paneProbed = true;
        return "dead";
      },
      dwellMs: 1000,
      pollMs: 500,
      ...fixedClock,
    });
    // The verdict carries the captured identity for the durable intent, and the
    // no-evidence pane path is never touched when evidence is present.
    expect(result).toEqual({ verdict: "verified", identity: ID });
    expect(paneProbed).toBe(false);
  });

  test("evidence appears on a later poll → verified", async () => {
    let calls = 0;
    const result = await verifyAttach({
      findEvidence: () => (++calls >= 3 ? ID : null),
      identityLiveness: () => "alive",
      paneLiveness: () => "dead",
      dwellMs: 0,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result.verdict).toBe("verified");
    expect(calls).toBe(3);
  });

  test("evidence then the process DIES inside the dwell → failed (die-after-verify)", async () => {
    // The exact mask this closes: a candidate verifies (evidence seen) then the
    // 17-way boot memory crunch kills the pane. A dwell probe re-observes the
    // death → failed, never a point-in-time false verified.
    let probes = 0;
    const result = await verifyAttach({
      findEvidence: () => ID,
      identityLiveness: () => (++probes >= 2 ? "dead" : "alive"),
      paneLiveness: () => "alive",
      dwellMs: 1500,
      pollMs: 500,
      ...fixedClock,
    });
    expect(result).toEqual({ verdict: "failed", identity: ID });
    expect(probes).toBe(2);
  });

  test("evidence but the dwell probe is only-ever inconclusive → launched-unverified", async () => {
    // Documented probe-failure fail-direction: a starved start-time read (unknown)
    // never asserts up (no false verified) nor down (no relaunch this apply) — it
    // resurfaces as a warn.
    const result = await verifyAttach({
      findEvidence: () => ID,
      identityLiveness: () => "unknown",
      paneLiveness: () => "alive",
      dwellMs: 1500,
      pollMs: 500,
      ...fixedClock,
    });
    expect(result).toEqual({ verdict: "launched-unverified", identity: ID });
  });

  test("no-evidence timeout + DEAD pane → failed (identity null)", async () => {
    let t = 0;
    const result = await verifyAttach({
      findEvidence: () => null,
      identityLiveness: () => "alive",
      paneLiveness: () => "dead",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(result).toEqual({ verdict: "failed", identity: null });
  });

  test("no-evidence timeout + ALIVE pane → launched-unverified", async () => {
    let t = 0;
    const result = await verifyAttach({
      findEvidence: () => null,
      identityLiveness: () => "alive",
      paneLiveness: () => "alive",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(result.verdict).toBe("launched-unverified");
  });

  test("no-evidence timeout + UNKNOWN pane → launched-unverified (never a false failed)", async () => {
    let t = 0;
    const result = await verifyAttach({
      findEvidence: () => null,
      identityLiveness: () => "alive",
      paneLiveness: () => "unknown",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(result.verdict).toBe("launched-unverified");
  });
});

// ---------------------------------------------------------------------------
// identityLiveness — the recycle-safe (pid, start_time) probe
// ---------------------------------------------------------------------------

describe("identityLiveness", () => {
  /** Build probe deps from a fixed liveness map + a start-time reader. */
  function deps(over: Partial<StartTimeProbeDeps> = {}): StartTimeProbeDeps {
    return {
      isPidAlive: () => true,
      readStartTime: () => "darwin:s",
      ...over,
    };
  }

  test("live pid whose start_time matches → alive", () => {
    expect(identityLiveness(100, "darwin:s", deps())).toBe("alive");
  });

  test("a gone pid → dead (never probes start_time)", () => {
    let readCalled = false;
    const live = identityLiveness(100, "darwin:s", {
      isPidAlive: () => false,
      readStartTime: () => {
        readCalled = true;
        return "darwin:s";
      },
    });
    expect(live).toBe("dead");
    expect(readCalled).toBe(false);
  });

  test("live pid whose start_time DIFFERS → dead (recycled pid, our process gone)", () => {
    expect(
      identityLiveness(
        100,
        "darwin:OLD",
        deps({ readStartTime: () => "darwin:NEW" }),
      ),
    ).toBe("dead");
  });

  test("live pid whose start_time can't be read → unknown (inconclusive)", () => {
    expect(
      identityLiveness(100, "darwin:s", deps({ readStartTime: () => null })),
    ).toBe("unknown");
  });

  test("live pid with NO stored start_time → bare-pid alive", () => {
    expect(identityLiveness(100, null, deps())).toBe("alive");
    expect(identityLiveness(100, "", deps())).toBe("alive");
  });

  test("no captured pid → unknown (nothing to probe)", () => {
    const noProbe = deps({
      isPidAlive: () => {
        throw new Error("must not probe a null pid");
      },
    });
    expect(identityLiveness(null, "darwin:s", noProbe)).toBe("unknown");
    expect(identityLiveness(0, "darwin:s", noProbe)).toBe("unknown");
    expect(identityLiveness(-1, "darwin:s", noProbe)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// restoreNoOpDecision — the live-UUID no-op gate over a stored verified intent
// ---------------------------------------------------------------------------

describe("restoreNoOpDecision", () => {
  const aliveDeps: StartTimeProbeDeps = {
    isPidAlive: () => true,
    readStartTime: () => "darwin:s",
  };
  const deadDeps: StartTimeProbeDeps = {
    isPidAlive: () => false,
    readStartTime: () => null,
  };
  const starvedDeps: StartTimeProbeDeps = {
    isPidAlive: () => true,
    readStartTime: () => null,
  };
  const verified = (over: Partial<RestoreIntent> = {}): RestoreIntent =>
    intent({
      state: "verified",
      verified_pid: 4242,
      verified_start_time: "darwin:s",
      ...over,
    });

  test("verified + stored identity still alive → skip (idempotent no-op)", () => {
    expect(restoreNoOpDecision(verified(), aliveDeps)).toEqual({
      skip: true,
      inconclusive: false,
    });
  });

  test("verified but the stored identity is DEAD → re-attempt (never a permanent no-op)", () => {
    // The mask this closes: a verified-then-died tab must relaunch, not skip.
    expect(restoreNoOpDecision(verified(), deadDeps)).toEqual({
      skip: false,
      inconclusive: false,
    });
  });

  test("verified but the probe is inconclusive → skip WITH the inconclusive flag", () => {
    // Fail-direction: don't double-spawn a possibly-live session, but flag the skip
    // so the caller never masks a death silently.
    expect(restoreNoOpDecision(verified(), starvedDeps)).toEqual({
      skip: true,
      inconclusive: true,
    });
  });

  test("a verified intent with NO stored handle skips inconclusively (backward-compat)", () => {
    const preHandle = intent({
      state: "verified",
      verified_pid: null,
      verified_start_time: null,
    });
    expect(restoreNoOpDecision(preHandle, aliveDeps)).toEqual({
      skip: true,
      inconclusive: true,
    });
  });

  test("a non-verified prior (or null) is never a no-op", () => {
    expect(restoreNoOpDecision(null, aliveDeps).skip).toBe(false);
    expect(
      restoreNoOpDecision(intent({ state: "failed" }), aliveDeps).skip,
    ).toBe(false);
    expect(
      restoreNoOpDecision(intent({ state: "launched" }), aliveDeps).skip,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// crash-loop bound
// ---------------------------------------------------------------------------

describe("crash-loop bound", () => {
  test("auto attempts are allowed up to the cap, then refused", () => {
    // No prior intent → attempt 1 allowed.
    expect(mayAttemptRestore(null, true)).toBe(true);
    // attempt already at the cap → the NEXT auto attempt is refused.
    expect(
      mayAttemptRestore(intent({ attempt: RESTORE_AUTO_ATTEMPT_CAP }), true),
    ).toBe(false);
    expect(mayAttemptRestore(intent({ attempt: 1 }), true)).toBe(true);
  });

  test("on-demand (auto=false) bypasses the bound", () => {
    expect(
      mayAttemptRestore(
        intent({ attempt: RESTORE_AUTO_ATTEMPT_CAP + 5 }),
        false,
      ),
    ).toBe(true);
  });

  test("crashLoopHint names the on-demand rerun command", () => {
    const hint = crashLoopHint({
      generation_id: "gen-9",
      backend_exec_session_id: "work",
    });
    expect(hint).toContain("keeper tabs restore --apply");
    expect(hint).toContain("--generation gen-9");
    expect(hint).toContain("--session work");
  });
});

// ---------------------------------------------------------------------------
// advisory apply flock — a second concurrent holder is a no-op success
// ---------------------------------------------------------------------------

describe("tryAcquireApplyLock", () => {
  const identity: ApplyLockIdentity = {
    pid: 123,
    startTs: "2026-07-07T00:00:00.000Z",
    uuid: "u-1",
  };

  test("a second concurrent acquire returns null (idempotent no-op)", () => {
    const dir = tmp("rv-lock-");
    const path = join(dir, "apply.lock");
    const first = tryAcquireApplyLock(path, identity);
    expect(first).not.toBeNull();
    // A second holder against the same path (a distinct open-file-description)
    // cannot take the exclusive lock → null, the caller's idempotent success.
    const second = tryAcquireApplyLock(path, identity);
    expect(second).toBeNull();
    first?.release();
    // Once released, the lock is takeable again.
    const third = tryAcquireApplyLock(path, identity);
    expect(third).not.toBeNull();
    third?.release();
  });

  test("stamps the holder identity into the lock file", () => {
    const dir = tmp("rv-lock-");
    const path = join(dir, "apply.lock");
    const lock = tryAcquireApplyLock(path, identity);
    expect(lock).not.toBeNull();
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body).toEqual(identity);
    lock?.release();
  });
});
