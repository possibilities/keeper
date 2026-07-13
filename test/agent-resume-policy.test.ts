/**
 * Pure in-process tests for `src/agent/resume-policy.ts` (ADR 0034) — the
 * resume-by-name policy layer over the bus's `resolveTarget`.
 * Seeds synthetic `jobs` rows into a `freshMemDb` clone (mirroring
 * `test/bus-identity.test.ts`'s `seedJob` shape) plus `harness` /
 * `resume_target` / `cwd`. Every liveness / codex-back-fill probe is injected
 * via `ResumePolicyDeps` — no real pid, subprocess, or filesystem read.
 */
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type ResumePolicyDeps,
  resolveResumeDecision,
} from "../src/agent/resume-policy";
import { freshMemDb } from "./helpers/template-db";

interface JobSeed {
  job_id: string;
  pid?: number | null;
  start_time?: string | null;
  title?: string | null;
  name_history?: string[];
  updated_at?: number;
  created_at?: number;
  harness?: string | null;
  resume_target?: string | null;
  cwd?: string | null;
}
function seedJob(db: Database, job: JobSeed): void {
  db.query(`INSERT INTO jobs (job_id, created_at, updated_at, state, pid, start_time,
                        title, name_history, harness, resume_target, cwd)
     VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?)`).run(
    job.job_id,
    job.created_at ?? 1,
    job.updated_at ?? 1,
    job.pid ?? null,
    job.start_time ?? null,
    job.title ?? null,
    JSON.stringify(job.name_history ?? []),
    job.harness ?? null,
    job.resume_target ?? null,
    job.cwd ?? null,
  );
}
/** Never-live deps by default (no pid seeded → isLive short-circuits false
 *  regardless), overridden per-test for the liveness cases. */
function deps(overrides: ResumePolicyDeps = {}): ResumePolicyDeps {
  return {
    isPidAlive: () => false,
    readStartTime: () => null,
    ...overrides,
  };
}
// ---------------------------------------------------------------------------
// Basic tiers — current name, former name, id, prefix
// ---------------------------------------------------------------------------
test("resolves a current name (title) to ok with harness/resume_target/cwd/title", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    title: "alpha",
    harness: "claude",
    resume_target: "native-1",
    cwd: "/repo",
  });
  const result = resolveResumeDecision("alpha", db, undefined, deps());
  expect(result).toEqual({
    kind: "ok",
    job_id: "sess-1",
    harness: "claude",
    resume_target: "native-1",
    cwd: "/repo",
    title: "alpha",
  });
});
test("resolves a full session id exactly", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-exact-id",
    harness: "pi",
    resume_target: "pi-target",
  });
  const result = resolveResumeDecision("sess-exact-id", db, undefined, deps());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") expect(result.job_id).toBe("sess-exact-id");
});
test("resolves a unique id prefix", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-prefix-xyz",
    harness: "pi",
    resume_target: "pi-target",
  });
  const result = resolveResumeDecision("sess-prefix", db, undefined, deps());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") expect(result.job_id).toBe("sess-prefix-xyz");
});
// ---------------------------------------------------------------------------
// Refuse-live
// ---------------------------------------------------------------------------
test("a live process (pid + start-time identity match) is refused, naming the candidate", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-live",
    title: "gamma",
    pid: 4242,
    start_time: "t-live",
    harness: "claude",
    resume_target: "native-live",
  });
  const result = resolveResumeDecision(
    "gamma",
    db,
    undefined,
    deps({
      isPidAlive: (pid) => pid === 4242,
      readStartTime: (pid) => (pid === 4242 ? "t-live" : null),
    }),
  );
  expect(result).toEqual({
    kind: "live",
    job_id: "sess-live",
    harness: "claude",
    title: "gamma",
  });
});
test("a recycled pid (same pid, different OS start_time) is NOT treated as live", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-recycled",
    title: "delta",
    pid: 5000,
    start_time: "t-original",
    harness: "claude",
    resume_target: "native-delta",
  });
  const result = resolveResumeDecision(
    "delta",
    db,
    undefined,
    deps({
      isPidAlive: (pid) => pid === 5000,
      // Same pid alive, but the OS start_time no longer matches the stored one.
      readStartTime: (pid) => (pid === 5000 ? "t-recycled" : null),
    }),
  );
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") expect(result.job_id).toBe("sess-recycled");
});
test("a row with NULL pid/start_time cannot be probed and is treated as not-live", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-no-pid",
    title: "epsilon",
    harness: "claude",
    resume_target: "native-epsilon",
  });
  const result = resolveResumeDecision(
    "epsilon",
    db,
    undefined,
    deps({
      isPidAlive: () => {
        throw new Error("must not be called for a NULL pid");
      },
    }),
  );
  expect(result.kind).toBe("ok");
});
// ---------------------------------------------------------------------------
// Newest-collapse + tie ambiguity
// ---------------------------------------------------------------------------
test("multiple non-live matches collapse to the newest by updated_at", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-old",
    title: "zeta",
    updated_at: 10,
    harness: "claude",
    resume_target: "native-old",
  });
  seedJob(db, {
    job_id: "sess-new",
    title: "zeta",
    updated_at: 20,
    harness: "claude",
    resume_target: "native-new",
  });
  const result = resolveResumeDecision("zeta", db, undefined, deps());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.job_id).toBe("sess-new");
    expect(result.resume_target).toBe("native-new");
  }
});
test("an unresolvable target returns unknown", () => {
  const { db } = freshMemDb();
  const result = resolveResumeDecision("no-such-target", db, undefined, deps());
  expect(result).toEqual({ kind: "unknown", target: "no-such-target" });
});
test.each(["claude", "pi"] as const)(
  "a %s row with a NULL resume_target fails immediately, no back-fill attempted",
  (harness) => {
    const { db } = freshMemDb();
    seedJob(db, {
      job_id: `sess-${harness}-null`,
      title: "nu",
      harness,
      resume_target: null,
    });
    const result = resolveResumeDecision("nu", db, undefined, deps());
    expect(result).toEqual({
      kind: "no-target",
      job_id: `sess-${harness}-null`,
      harness,
      title: "nu",
    });
  },
);
test("a NULL harness column normalizes to claude", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-null-harness",
    title: "xi",
    harness: null,
    resume_target: "native-xi",
  });
  const result = resolveResumeDecision("xi", db, undefined, deps());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") expect(result.harness).toBe("claude");
});
