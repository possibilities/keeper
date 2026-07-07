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
  classifyPaneLiveness,
  claudeAttachEvidence,
  completeLines,
  crashLoopHint,
  gcRestoreIntents,
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
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    ...over,
  };
}

/** One events-log NDJSON line for a SessionStart on `sessionId` at `tsSecs`. */
function sessionStartLine(sessionId: string, tsSecs: number): string {
  return `${JSON.stringify({
    bindings: {
      ts: tsSecs,
      session_id: sessionId,
      hook_event: "SessionStart",
      event_type: "session_start",
    },
  })}\n`;
}

/** One birth-record file body carrying `sessionId` (== keeper job id). */
function birthBody(sessionId: string, launchIso: string): string {
  return `${JSON.stringify({
    schema_version: 1,
    session_id: sessionId,
    harness: "pi",
    pid: 4242,
    start_time: null,
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
  test("true for a SessionStart matching the exact session id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(join(dir, "111.ndjson"), sessionStartLine("wanted", 1000));
    expect(claudeAttachEvidence(dir, "wanted")).toBe(true);
  });

  test("false for a SessionStart of a DIFFERENT session id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(join(dir, "111.ndjson"), sessionStartLine("other", 1000));
    expect(claudeAttachEvidence(dir, "wanted")).toBe(false);
  });

  test("false for a non-SessionStart event on the same id", () => {
    const dir = tmp("rv-events-");
    writeFileSync(
      join(dir, "111.ndjson"),
      `${JSON.stringify({
        bindings: { ts: 1000, session_id: "wanted", hook_event: "Stop" },
      })}\n`,
    );
    expect(claudeAttachEvidence(dir, "wanted")).toBe(false);
  });

  test("a torn final line is never consumed as evidence", () => {
    const dir = tmp("rv-events-");
    // The matching SessionStart is the trailing PARTIAL (no newline) → not read.
    const partial = sessionStartLine("wanted", 1000).replace(/\n$/, "");
    writeFileSync(join(dir, "111.ndjson"), `noise\n${partial}`);
    expect(claudeAttachEvidence(dir, "wanted")).toBe(false);
  });

  test("recency gate rejects a STALE pre-crash SessionStart", () => {
    const dir = tmp("rv-events-");
    // Event at t=1000s (1_000_000 ms); floor at 2_000_000 ms → rejected.
    writeFileSync(join(dir, "111.ndjson"), sessionStartLine("wanted", 1000));
    expect(claudeAttachEvidence(dir, "wanted", 2_000_000)).toBe(false);
    // A fresh event at t=3000s (3_000_000 ms) clears the same floor.
    writeFileSync(join(dir, "222.ndjson"), sessionStartLine("wanted", 3000));
    expect(claudeAttachEvidence(dir, "wanted", 2_000_000)).toBe(true);
  });

  test("empty session id and absent dir are both no-evidence", () => {
    const dir = tmp("rv-events-");
    expect(claudeAttachEvidence(dir, "")).toBe(false);
    expect(claudeAttachEvidence(join(dir, "nope"), "wanted")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// non-claude attach evidence — birth record on the carried job id
// ---------------------------------------------------------------------------

describe("nonClaudeAttachEvidence", () => {
  test("true for a birth record carrying the job id", () => {
    const dir = tmp("rv-birth-");
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(
      join(dir, "new", "4242.rec.json"),
      birthBody("job-x", "2026-07-07T01:00:00.000Z"),
    );
    expect(nonClaudeAttachEvidence(dir, "job-x")).toBe(true);
    expect(nonClaudeAttachEvidence(dir, "job-other")).toBe(false);
  });

  test("recency gate rejects a stale birth record", () => {
    const dir = tmp("rv-birth-");
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(
      join(dir, "new", "4242.rec.json"),
      birthBody("job-x", "2026-07-07T00:00:00.000Z"),
    );
    const floor = Date.parse("2026-07-07T02:00:00.000Z");
    expect(nonClaudeAttachEvidence(dir, "job-x", floor)).toBe(false);
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
// verifyAttach — the bounded state matrix
// ---------------------------------------------------------------------------

describe("verifyAttach", () => {
  const fixedClock = { now: () => 0, sleep: async () => {} };

  test("evidence present immediately → verified (never touches the pane)", async () => {
    let paneProbed = false;
    const verdict = await verifyAttach({
      hasEvidence: () => true,
      paneLiveness: () => {
        paneProbed = true;
        return "dead";
      },
      ...fixedClock,
    });
    expect(verdict).toBe("verified");
    expect(paneProbed).toBe(false);
  });

  test("evidence appears on a later poll → verified", async () => {
    let calls = 0;
    const verdict = await verifyAttach({
      hasEvidence: () => ++calls >= 3,
      paneLiveness: () => "dead",
      now: () => 0,
      sleep: async () => {},
    });
    expect(verdict).toBe("verified");
    expect(calls).toBe(3);
  });

  test("no-evidence timeout + DEAD pane → failed", async () => {
    let t = 0;
    const verdict = await verifyAttach({
      hasEvidence: () => false,
      paneLiveness: () => "dead",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(verdict).toBe("failed");
  });

  test("no-evidence timeout + ALIVE pane → launched-unverified", async () => {
    let t = 0;
    const verdict = await verifyAttach({
      hasEvidence: () => false,
      paneLiveness: () => "alive",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(verdict).toBe("launched-unverified");
  });

  test("no-evidence timeout + UNKNOWN pane → launched-unverified (never a false failed)", async () => {
    let t = 0;
    const verdict = await verifyAttach({
      hasEvidence: () => false,
      paneLiveness: () => "unknown",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 100,
    });
    expect(verdict).toBe("launched-unverified");
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
