/**
 * Pure in-process tests for `src/agent/resume-policy.ts` (epic fn-1232, ADR
 * 0034) — the resume-by-name policy layer over the bus's `resolveTarget`.
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
  db.query(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, pid, start_time,
                        title, name_history, harness, resume_target, cwd)
     VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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

test("resolves a FORMER name (name_history) to the same job", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-1",
    title: "beta",
    name_history: ["alpha", "beta"],
    harness: "codex",
    resume_target: "rollout-uuid",
  });
  const result = resolveResumeDecision("alpha", db, undefined, deps());
  expect(result.kind).toBe("ok");
  if (result.kind === "ok") {
    expect(result.job_id).toBe("sess-1");
    expect(result.harness).toBe("codex");
    expect(result.resume_target).toBe("rollout-uuid");
  }
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
    harness: "hermes",
    resume_target: "hermes-target",
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

test("an exact updated_at tie returns ambiguous listing every tied candidate with id + harness", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-tie-a",
    title: "eta",
    updated_at: 30,
    harness: "claude",
    resume_target: "native-a",
  });
  seedJob(db, {
    job_id: "sess-tie-b",
    title: "eta",
    updated_at: 30,
    harness: "codex",
    resume_target: "native-b",
  });
  const result = resolveResumeDecision("eta", db, undefined, deps());
  expect(result.kind).toBe("ambiguous");
  if (result.kind === "ambiguous") {
    expect(result.candidates).toHaveLength(2);
    const ids = result.candidates.map((c) => c.job_id).sort();
    expect(ids).toEqual(["sess-tie-a", "sess-tie-b"]);
    for (const c of result.candidates) {
      expect(typeof c.harness).toBe("string");
      expect(c.updated_at).toBe(30);
    }
  }
});

// ---------------------------------------------------------------------------
// requireHarness + unknown
// ---------------------------------------------------------------------------

test("requireHarness mismatch returns a distinct kind naming the actual harness found", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-claude",
    title: "theta",
    harness: "claude",
    resume_target: "native-theta",
  });
  const result = resolveResumeDecision("theta", db, "codex", deps());
  expect(result).toEqual({
    kind: "harness-mismatch",
    job_id: "sess-claude",
    harness: "claude",
    require_harness: "codex",
    title: "theta",
  });
});

test("requireHarness match resolves ok normally", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-codex",
    title: "iota",
    harness: "codex",
    resume_target: "native-iota",
  });
  const result = resolveResumeDecision("iota", db, "codex", deps());
  expect(result.kind).toBe("ok");
});

test("an unresolvable target returns unknown", () => {
  const { db } = freshMemDb();
  const result = resolveResumeDecision("no-such-target", db, undefined, deps());
  expect(result).toEqual({ kind: "unknown", target: "no-such-target" });
});

// ---------------------------------------------------------------------------
// NULL resume_target — codex back-fill vs immediate failure
// ---------------------------------------------------------------------------

test("a codex row with a NULL resume_target attempts the rollout back-fill and succeeds", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-codex-null",
    title: "kappa",
    harness: "codex",
    resume_target: null,
    cwd: "/repo/codex",
    created_at: 100,
  });
  let calledWith: unknown = null;
  const result = resolveResumeDecision(
    "kappa",
    db,
    undefined,
    deps({
      resolveCodexResumeTarget: (opts) => {
        calledWith = opts;
        return "backfilled-uuid";
      },
      codexHome: "/fake/codex-home",
    }),
  );
  expect(result).toEqual({
    kind: "ok",
    job_id: "sess-codex-null",
    harness: "codex",
    resume_target: "backfilled-uuid",
    cwd: "/repo/codex",
    title: "kappa",
  });
  expect(calledWith).toEqual({
    codexHome: "/fake/codex-home",
    jobId: "sess-codex-null",
    expectedCwd: "/repo/codex",
    startedAtMs: 100_000,
  });
});

test("a codex row with a NULL resume_target that the back-fill cannot resolve errors no-target", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-codex-unresolvable",
    title: "lambda",
    harness: "codex",
    resume_target: null,
  });
  const result = resolveResumeDecision(
    "lambda",
    db,
    undefined,
    deps({
      resolveCodexResumeTarget: () => null,
      codexHome: "/fake/codex-home",
    }),
  );
  expect(result).toEqual({
    kind: "no-target",
    job_id: "sess-codex-unresolvable",
    harness: "codex",
    title: "lambda",
  });
});

test("a codex row with a NULL resume_target and no codexHome skips back-fill and errors no-target", () => {
  const { db } = freshMemDb();
  seedJob(db, {
    job_id: "sess-codex-no-home",
    title: "mu",
    harness: "codex",
    resume_target: null,
  });
  const result = resolveResumeDecision(
    "mu",
    db,
    undefined,
    deps({
      resolveCodexResumeTarget: () => {
        throw new Error("must not be called without codexHome");
      },
    }),
  );
  expect(result.kind).toBe("no-target");
});

test.each(["claude", "pi", "hermes"] as const)(
  "a %s row with a NULL resume_target fails immediately, no back-fill attempted",
  (harness) => {
    const { db } = freshMemDb();
    seedJob(db, {
      job_id: `sess-${harness}-null`,
      title: "nu",
      harness,
      resume_target: null,
    });
    const result = resolveResumeDecision(
      "nu",
      db,
      undefined,
      deps({
        resolveCodexResumeTarget: () => {
          throw new Error(`must not be called for harness ${harness}`);
        },
        codexHome: "/fake/codex-home",
      }),
    );
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
