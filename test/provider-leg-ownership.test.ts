/**
 * Durable wrapper→Provider-leg ownership registry, terminal cascade, fenced
 * transfer, and release-fold self-verification (ADR 0071, task 1 — the inert
 * schema + projection + fold layer).
 *
 * Each test clones the migrated `:memory:` template (`freshMemDb`), seeds raw
 * `events` rows for the NEW synthetic kinds, drives the reducer, and asserts the
 * `provider_leg_ownership` / `provider_leg_cascades` projections plus the release
 * gate on `dispatch_claims`. No producer mints these events in production yet;
 * this proves the fold layer folds them deterministically and idempotently.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  BIRTH_RECORD_SCHEMA_VERSION,
  type BirthRecord,
  birthRecordIsLegacyProtocol,
  OWNED_LEG_BIRTH_PROTOCOL_VERSION,
  ownerTupleFromBirthRecord,
  parseBirthRecord,
  serializeBirthRecord,
} from "../src/birth-record";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tsCounter = 5_000;

/** Insert one raw synthetic event; returns its auto-assigned event id. `ts`
 *  defaults to a monotonic counter so ordering is stable; pass it explicitly
 *  when an assertion pins a folded timestamp to a known value. */
function insertEvent(o: {
  hook_event: string;
  session_id?: string;
  data?: Record<string, unknown>;
  ts?: number;
}): number {
  const ts = o.ts ?? tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      ts,
      o.session_id ?? "reconciler",
      o.hook_event,
      o.hook_event,
      JSON.stringify(o.data ?? {}),
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

function drainAll(): void {
  while (drain(db) > 0) {
    /* fold to completion */
  }
}

function ownershipRow(legLaunchId: string) {
  return db
    .query("SELECT * FROM provider_leg_ownership WHERE leg_launch_id = ?")
    .get(legLaunchId) as Record<string, unknown> | null;
}

function cascadeRow(legLaunchId: string, epoch: number) {
  return db
    .query(
      "SELECT * FROM provider_leg_cascades WHERE leg_launch_id = ? AND ownership_epoch_event_id = ?",
    )
    .get(legLaunchId, epoch) as Record<string, unknown> | null;
}

function claimRow(verb: string, id: string) {
  return db
    .query("SELECT * FROM dispatch_claims WHERE verb = ? AND id = ?")
    .get(verb, id) as Record<string, unknown> | null;
}

/** Drive a (verb,id) claim to `bound` under `attemptId`, mirroring the real
 *  acquire→bind lifecycle so the release fold sees a genuine live claim. */
function bindClaim(verb: string, id: string, attemptId: number): void {
  insertEvent({
    hook_event: "Dispatched",
    data: { verb, id, dir: "/repo", ts: tsCounter, attempt_id: attemptId },
  });
  insertEvent({
    hook_event: "DispatchClaimBound",
    data: {
      verb,
      id,
      expected_attempt_id: attemptId,
      session_id: `sess-${id}`,
    },
  });
  drainAll();
}

// ---------------------------------------------------------------------------
// Birth record: owner tuple round-trip + legacy classification.
// ---------------------------------------------------------------------------

test("a v2 owned-leg birth round-trips the owner tuple, leg id, and launcher identity", () => {
  const owned: BirthRecord = {
    schema_version: OWNED_LEG_BIRTH_PROTOCOL_VERSION,
    session_id: "leg-job-9",
    harness: "pi",
    pid: 4242,
    start_time: "darwin:Wed Jul  3 12:00:00 2026",
    cwd: "/repo",
    spawn_name: "fn-7.1",
    config_dir: null,
    backend_exec_type: "tmux",
    backend_exec_session_id: "wrapped",
    backend_exec_pane_id: "%12",
    worktree: null,
    launch_ts: "2026-07-03T12:00:00.000Z",
    resume_target: null,
    dispatch_attempt_id: null,
    leg_launch_id: "leg-abc-123",
    wrapper_job_id: "work::fn-7.1",
    wrapper_dispatch_attempt_id: 88,
    launcher_pid: 900,
    launcher_start_time: "darwin:Wed Jul  3 11:59:59 2026",
  };
  const parsed = parseBirthRecord(serializeBirthRecord(owned));
  expect(parsed).toEqual(owned);
  expect(ownerTupleFromBirthRecord(owned)).toEqual({
    leg_launch_id: "leg-abc-123",
    wrapper_job_id: "work::fn-7.1",
    wrapper_dispatch_attempt_id: 88,
  });
  expect(birthRecordIsLegacyProtocol(owned)).toBe(false);
});

test("a legacy v1 birth is classified by protocol version and never enrolled", () => {
  const legacy = {
    schema_version: 1,
    session_id: "legacy-leg",
    harness: "pi" as const,
    pid: 100,
    start_time: null,
    cwd: "/repo",
    spawn_name: null,
    config_dir: null,
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
    worktree: null,
    launch_ts: "2026-07-03T12:00:00.000Z",
    resume_target: null,
    dispatch_attempt_id: null,
  };
  const parsed = parseBirthRecord(serializeBirthRecord(legacy));
  expect(parsed).not.toBeNull();
  // Legacy is parseable (still ingests via the old autoclose path)...
  expect(parsed?.schema_version).toBe(1);
  expect(birthRecordIsLegacyProtocol(parsed as BirthRecord)).toBe(true);
  // ...but never enrolled into ownership.
  expect(ownerTupleFromBirthRecord(parsed as BirthRecord)).toBeNull();
});

test("owner fields on a legacy v1 body are ignored — classification never infers from null fields", () => {
  // A v1 body that carries owner-shaped keys is STILL legacy: the protocol
  // version decides enrollment, not which fields happen to be present.
  const spoofed = parseBirthRecord(
    JSON.stringify({
      schema_version: 1,
      session_id: "spoof",
      harness: "pi",
      pid: 1,
      start_time: null,
      cwd: "/r",
      spawn_name: null,
      config_dir: null,
      backend_exec_type: null,
      backend_exec_session_id: null,
      backend_exec_pane_id: null,
      worktree: null,
      launch_ts: "t",
      resume_target: null,
      dispatch_attempt_id: null,
      leg_launch_id: "leg-x",
      wrapper_job_id: "w",
      wrapper_dispatch_attempt_id: 5,
    }),
  );
  expect(spoofed).not.toBeNull();
  expect(spoofed?.leg_launch_id).toBeUndefined();
  expect(ownerTupleFromBirthRecord(spoofed as BirthRecord)).toBeNull();
});

test("a v2 non-wrapped birth carries no tuple but is not legacy", () => {
  const ownerless = parseBirthRecord(
    JSON.stringify({
      schema_version: OWNED_LEG_BIRTH_PROTOCOL_VERSION,
      session_id: "manual-pi",
      harness: "pi",
      pid: 1,
      start_time: null,
      cwd: "/r",
      spawn_name: null,
      config_dir: null,
      backend_exec_type: null,
      backend_exec_session_id: null,
      backend_exec_pane_id: null,
      worktree: null,
      launch_ts: "t",
      resume_target: null,
      dispatch_attempt_id: null,
    }),
  );
  expect(ownerless).not.toBeNull();
  expect(birthRecordIsLegacyProtocol(ownerless as BirthRecord)).toBe(false);
  expect(ownerTupleFromBirthRecord(ownerless as BirthRecord)).toBeNull();
});

test("parse accepts both supported protocol versions and rejects an unknown one", () => {
  const base = {
    session_id: "s",
    harness: "pi",
    pid: 1,
    start_time: null,
    cwd: "/r",
    spawn_name: null,
    config_dir: null,
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
    worktree: null,
    launch_ts: "t",
    resume_target: null,
    dispatch_attempt_id: null,
  };
  expect(
    parseBirthRecord(JSON.stringify({ ...base, schema_version: 1 })),
  ).not.toBeNull();
  expect(
    parseBirthRecord(JSON.stringify({ ...base, schema_version: 2 })),
  ).not.toBeNull();
  expect(
    parseBirthRecord(
      JSON.stringify({
        ...base,
        schema_version: BIRTH_RECORD_SCHEMA_VERSION + 1,
      }),
    ),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// Ownership registry: enrollment, "all legs owned by attempt X", exit proof.
// ---------------------------------------------------------------------------

function bornEvent(over: Record<string, unknown> = {}): number {
  return insertEvent({
    hook_event: "ProviderLegBorn",
    data: {
      leg_launch_id: "leg-1",
      wrapper_job_id: "work::fn-1.1",
      wrapper_dispatch_attempt_id: 42,
      leg_session_id: "leg-sess-1",
      leg_pid: 3001,
      leg_start_time: "darwin:Wed Jul  3 12:00:00 2026",
      launcher_pid: 900,
      launcher_start_time: "darwin:Wed Jul  3 11:59:59 2026",
      pane_id: "%7",
      pane_generation: 4,
      backend_exec_type: "tmux",
      backend_exec_session_id: "wrapped",
      ...over,
    },
  });
}

test("ProviderLegBorn enrolls a live leg and captures the recycle-corroboration identity", () => {
  const bornId = bornEvent();
  drainAll();
  const row = ownershipRow("leg-1");
  // The recycle-safe exit-proof data shape: process identity + pane/generation
  // coords a later 1s-recycle check corroborates against (birth is the only
  // place they can be captured — a terminal job row nulls its pane ids).
  expect(row).toMatchObject({
    leg_launch_id: "leg-1",
    wrapper_job_id: "work::fn-1.1",
    wrapper_dispatch_attempt_id: 42,
    ownership_epoch_event_id: bornId,
    leg_session_id: "leg-sess-1",
    leg_pid: 3001,
    leg_start_time: "darwin:Wed Jul  3 12:00:00 2026",
    launcher_pid: 900,
    launcher_start_time: "darwin:Wed Jul  3 11:59:59 2026",
    pane_id: "%7",
    pane_generation: 4,
    backend_exec_type: "tmux",
    backend_exec_session_id: "wrapped",
    state: "live",
    settled_event_id: null,
  });
});

test("ProviderLegBorn is set-once on leg_launch_id — a re-announce is idempotent", () => {
  const first = bornEvent({ pane_generation: 1 });
  drainAll();
  bornEvent({ pane_generation: 99, wrapper_dispatch_attempt_id: 999 });
  drainAll();
  const row = ownershipRow("leg-1");
  // The FIRST birth's owner + epoch + coords win; the second no-ops.
  expect(row).toMatchObject({
    ownership_epoch_event_id: first,
    wrapper_dispatch_attempt_id: 42,
    pane_generation: 1,
  });
});

test("the registry answers 'all legs owned by attempt X'", () => {
  bornEvent({ leg_launch_id: "leg-a", wrapper_dispatch_attempt_id: 7 });
  bornEvent({ leg_launch_id: "leg-b", wrapper_dispatch_attempt_id: 7 });
  bornEvent({ leg_launch_id: "leg-c", wrapper_dispatch_attempt_id: 8 });
  drainAll();
  const owned = db
    .query(
      "SELECT leg_launch_id FROM provider_leg_ownership WHERE wrapper_dispatch_attempt_id = ? ORDER BY leg_launch_id",
    )
    .all(7) as { leg_launch_id: string }[];
  expect(owned.map((r) => r.leg_launch_id)).toEqual(["leg-a", "leg-b"]);
});

test("ProviderLegExitConfirmed settles a live leg to terminal and is idempotent", () => {
  bornEvent();
  drainAll();
  const exitId = insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-1" },
  });
  drainAll();
  expect(ownershipRow("leg-1")).toMatchObject({
    state: "terminal",
    settled_event_id: exitId,
  });
  // A duplicate exit event does not re-settle (settled_event_id stays the first).
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-1" },
  });
  drainAll();
  expect(ownershipRow("leg-1")?.settled_event_id).toBe(exitId);
});

test("malformed ownership events fold to a safe no-op and never throw", () => {
  // Missing owner tuple → no row; a bad phase / unknown leg → no row.
  insertEvent({ hook_event: "ProviderLegBorn", data: { leg_launch_id: "x" } });
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "never-born" },
  });
  drainAll();
  expect(
    db.query("SELECT COUNT(*) AS n FROM provider_leg_ownership").get(),
  ).toEqual({ n: 0 });
});

// ---------------------------------------------------------------------------
// Fenced ownership transfer.
// ---------------------------------------------------------------------------

test("a well-formed transfer moves the owner tuple and advances the ownership epoch", () => {
  bornEvent();
  drainAll();
  const transferId = insertEvent({
    hook_event: "ProviderLegOwnershipTransferred",
    data: {
      leg_launch_id: "leg-1",
      from_wrapper_job_id: "work::fn-1.1",
      from_wrapper_dispatch_attempt_id: 42,
      to_wrapper_job_id: "work::fn-1.2",
      to_wrapper_dispatch_attempt_id: 43,
    },
  });
  drainAll();
  expect(ownershipRow("leg-1")).toMatchObject({
    wrapper_job_id: "work::fn-1.2",
    wrapper_dispatch_attempt_id: 43,
    ownership_epoch_event_id: transferId,
    state: "live",
  });
});

test("a stale transfer whose `from` is not the current owner no-ops deterministically", () => {
  const bornId = bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegOwnershipTransferred",
    data: {
      leg_launch_id: "leg-1",
      from_wrapper_job_id: "work::WRONG",
      from_wrapper_dispatch_attempt_id: 41,
      to_wrapper_job_id: "work::fn-1.2",
      to_wrapper_dispatch_attempt_id: 43,
    },
  });
  drainAll();
  // Owner + epoch unchanged from birth.
  expect(ownershipRow("leg-1")).toMatchObject({
    wrapper_dispatch_attempt_id: 42,
    ownership_epoch_event_id: bornId,
  });
});

test("transfer is refused once terminal proof exists", () => {
  bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-1" },
  });
  drainAll();
  insertEvent({
    hook_event: "ProviderLegOwnershipTransferred",
    data: {
      leg_launch_id: "leg-1",
      from_wrapper_job_id: "work::fn-1.1",
      from_wrapper_dispatch_attempt_id: 42,
      to_wrapper_job_id: "work::fn-1.2",
      to_wrapper_dispatch_attempt_id: 43,
    },
  });
  drainAll();
  // Still terminal, still owned by the original attempt — the transfer refused.
  expect(ownershipRow("leg-1")).toMatchObject({
    state: "terminal",
    wrapper_dispatch_attempt_id: 42,
  });
});

test("transfer is refused once TERM is armed for the current epoch", () => {
  const bornId = bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegCascadeArmed",
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      wrapper_job_id: "work::fn-1.1",
      wrapper_dispatch_attempt_id: 42,
      kill_not_before: 6000,
    },
  });
  drainAll();
  insertEvent({
    hook_event: "ProviderLegOwnershipTransferred",
    data: {
      leg_launch_id: "leg-1",
      from_wrapper_job_id: "work::fn-1.1",
      from_wrapper_dispatch_attempt_id: 42,
      to_wrapper_job_id: "work::fn-1.2",
      to_wrapper_dispatch_attempt_id: 43,
    },
  });
  drainAll();
  expect(ownershipRow("leg-1")).toMatchObject({
    wrapper_dispatch_attempt_id: 42,
    ownership_epoch_event_id: bornId,
  });
});

// ---------------------------------------------------------------------------
// Cascade projection: deadlines, attempt counts, page-once, settlement.
// ---------------------------------------------------------------------------

test("ProviderLegCascadeArmed opens an incident with TERM armed and the stored kill deadline", () => {
  const bornId = bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegCascadeArmed",
    ts: 6100,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      wrapper_job_id: "work::fn-1.1",
      wrapper_dispatch_attempt_id: 42,
      kill_not_before: 6600,
    },
  });
  drainAll();
  expect(cascadeRow("leg-1", bornId)).toMatchObject({
    state: "armed",
    term_armed_at: 6100,
    kill_not_before: 6600,
    term_attempts: 0,
    kill_attempts: 0,
    human_notified_at: null,
  });
});

test("cascade progression records signal timestamps, MAX attempt counts, and page-once notify", () => {
  const bornId = bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegCascadeArmed",
    ts: 6100,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      wrapper_job_id: "work::fn-1.1",
      wrapper_dispatch_attempt_id: 42,
      kill_not_before: 6600,
    },
  });
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 6200,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "term_sent",
      attempt_ordinal: 1,
    },
  });
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 6300,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "kill_sent",
      attempt_ordinal: 2,
    },
  });
  drainAll();
  expect(cascadeRow("leg-1", bornId)).toMatchObject({
    state: "killing",
    term_sent_at: 6200,
    kill_sent_at: 6300,
    term_attempts: 1,
    kill_attempts: 2,
  });

  // A blocked incident sets the reason and pages the human exactly once.
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 6400,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "blocked",
      reason: "kill-unconfirmed",
      notified: true,
    },
  });
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 6500,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "blocked",
      reason: "kill-unconfirmed",
      notified: true,
    },
  });
  drainAll();
  expect(cascadeRow("leg-1", bornId)).toMatchObject({
    state: "blocked",
    blocked_reason: "kill-unconfirmed",
    human_notified_at: 6400,
  });
});

test("a duplicate signal is idempotent: first-write-wins timestamp, MAX attempts hold", () => {
  const bornId = bornEvent();
  drainAll();
  insertEvent({
    hook_event: "ProviderLegCascadeArmed",
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      wrapper_job_id: "work::fn-1.1",
      wrapper_dispatch_attempt_id: 42,
      kill_not_before: 1,
    },
  });
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 7000,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "term_sent",
      attempt_ordinal: 3,
    },
  });
  // A REPLAY of the same phase with a LOWER ordinal + later ts must not regress.
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    ts: 7500,
    data: {
      leg_launch_id: "leg-1",
      ownership_epoch_event_id: bornId,
      phase: "term_sent",
      attempt_ordinal: 1,
    },
  });
  drainAll();
  expect(cascadeRow("leg-1", bornId)).toMatchObject({
    term_sent_at: 7000,
    term_attempts: 3,
  });
});

// ---------------------------------------------------------------------------
// Release fold self-verification.
// ---------------------------------------------------------------------------

test("release is blocked while an owned leg is still live, and proceeds once it settles", () => {
  bindClaim("work", "fn-9.1", 500);
  bornEvent({ leg_launch_id: "leg-9", wrapper_dispatch_attempt_id: 500 });
  drainAll();
  expect(claimRow("work", "fn-9.1")?.state).toBe("bound");

  // Live owned leg → release is a no-op, claim stays held.
  insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.1", expected_attempt_id: 500 },
  });
  drainAll();
  expect(claimRow("work", "fn-9.1")?.state).toBe("bound");

  // Leg exit-confirmed → the precondition is met → release proceeds.
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-9" },
  });
  const releaseId = insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.1", expected_attempt_id: 500 },
  });
  drainAll();
  expect(claimRow("work", "fn-9.1")).toMatchObject({
    state: "released",
    last_event_id: releaseId,
  });
});

test("release is blocked while a cascade intent is unresolved, and proceeds once confirmed", () => {
  bindClaim("work", "fn-9.2", 600);
  const bornId = bornEvent({
    leg_launch_id: "leg-92",
    wrapper_dispatch_attempt_id: 600,
  });
  drainAll();
  // Settle the leg so ONLY the cascade intent gates the release.
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-92" },
  });
  insertEvent({
    hook_event: "ProviderLegCascadeArmed",
    data: {
      leg_launch_id: "leg-92",
      ownership_epoch_event_id: bornId,
      wrapper_job_id: "work::fn-9.2",
      wrapper_dispatch_attempt_id: 600,
      kill_not_before: 1,
    },
  });
  drainAll();

  insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.2", expected_attempt_id: 600 },
  });
  drainAll();
  expect(claimRow("work", "fn-9.2")?.state).toBe("bound");

  // Confirm the cascade → no unresolved intent → release proceeds.
  insertEvent({
    hook_event: "ProviderLegCascadeProgressed",
    data: {
      leg_launch_id: "leg-92",
      ownership_epoch_event_id: bornId,
      phase: "confirmed",
    },
  });
  insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.2", expected_attempt_id: 600 },
  });
  drainAll();
  expect(claimRow("work", "fn-9.2")?.state).toBe("released");
});

test("a release for a normal attempt owning no legs proceeds unchanged (regression guard)", () => {
  bindClaim("work", "fn-9.3", 700);
  insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.3", expected_attempt_id: 700 },
  });
  drainAll();
  expect(claimRow("work", "fn-9.3")?.state).toBe("released");
});

test("a duplicate release after settlement is an idempotent no-op", () => {
  bindClaim("work", "fn-9.4", 800);
  bornEvent({ leg_launch_id: "leg-94", wrapper_dispatch_attempt_id: 800 });
  drainAll();
  insertEvent({
    hook_event: "ProviderLegExitConfirmed",
    data: { leg_launch_id: "leg-94" },
  });
  const releaseId = insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.4", expected_attempt_id: 800 },
  });
  drainAll();
  const afterFirst = claimRow("work", "fn-9.4");
  expect(afterFirst).toMatchObject({
    state: "released",
    last_event_id: releaseId,
  });

  insertEvent({
    hook_event: "DispatchClaimReleased",
    data: { verb: "work", id: "fn-9.4", expected_attempt_id: 800 },
  });
  drainAll();
  // Unchanged — the second release finds an already-released claim.
  expect(claimRow("work", "fn-9.4")).toEqual(afterFirst);
});
