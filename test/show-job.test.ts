/**
 * Unit tests for `keeper show-job`'s PURE resolver (epic fn-840). Every
 * resolution path is driven in-process via `freshMemDb()` with synthetic
 * selectors — no tmux/env/fs needed. `resolveJob(db, selectors)` takes a db
 * handle + fully-resolved plain-data selectors, so the tmux window-scope is
 * exercised by feeding a synthetic `paneIds` array.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildEnvelope,
  decodeFor,
  type ResolveResult,
  resolveJob,
  main as showJobMain,
} from "../cli/show-job";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

interface SeedRow {
  job_id: string;
  created_at?: number;
  updated_at?: number;
  active_since?: number | null;
  cwd?: string | null;
  state?: string;
  title?: string | null;
  name_history?: string;
  backend_exec_pane_id?: string | null;
}

let clock = 1000;

function seed(row: SeedRow): void {
  const created = row.created_at ?? clock++;
  db.query(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, active_since, cwd, state, title,
        name_history, backend_exec_pane_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.job_id,
    created,
    row.updated_at ?? created,
    row.active_since ?? null,
    row.cwd ?? null,
    row.state ?? "stopped",
    row.title ?? null,
    row.name_history ?? "[]",
    row.backend_exec_pane_id ?? null,
  );
}

/** Narrow an ok result, asserting it matched. */
function okRow(r: ResolveResult): Record<string, unknown> {
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") throw new Error("not ok");
  return r.row;
}

describe("resolveJob — job-id", () => {
  test("exact match returns the full row", () => {
    seed({ job_id: "sess-A", title: "Alpha" });
    const r = resolveJob(db, { jobId: "sess-A" });
    expect(okRow(r).job_id).toBe("sess-A");
    if (r.kind === "ok") expect(r.matchedField).toBe("job_id");
  });

  test("unknown id → not_found", () => {
    seed({ job_id: "sess-A" });
    expect(resolveJob(db, { jobId: "nope" }).kind).toBe("not_found");
  });

  test("id + a failing consistency selector → not_found, never blind-trust", () => {
    seed({ job_id: "sess-A", title: "Alpha" });
    // Right id, wrong title → the AND narrows it away.
    const r = resolveJob(db, { jobId: "sess-A", title: "WrongTitle" });
    expect(r.kind).toBe("not_found");
  });

  test("id + a passing consistency selector → ok", () => {
    seed({ job_id: "sess-A", title: "Alpha" });
    const r = resolveJob(db, { jobId: "sess-A", title: "alpha" });
    expect(okRow(r).job_id).toBe("sess-A");
  });
});

describe("resolveJob — session title", () => {
  test("matches current title case-insensitively", () => {
    seed({ job_id: "j1", title: "My Session" });
    expect(okRow(resolveJob(db, { title: "my session" })).job_id).toBe("j1");
  });

  test("matches a name_history entry (NOCASE)", () => {
    seed({
      job_id: "j1",
      title: "Renamed Now",
      name_history: JSON.stringify(["Old Name", "Older"]),
    });
    expect(okRow(resolveJob(db, { title: "old name" })).job_id).toBe("j1");
  });

  test("same-row title+history match dedups to ONE row", () => {
    // Title equals a history entry — must not double-count into ambiguity.
    seed({
      job_id: "j1",
      title: "Same",
      name_history: JSON.stringify(["Same"]),
    });
    const r = resolveJob(db, { title: "same" });
    expect(r.kind).toBe("ok");
  });

  test("cross-row peers (current title vs renamed-away history) → ambiguity rule", () => {
    seed({
      job_id: "live",
      title: "Shared",
      state: "working",
    });
    seed({
      job_id: "dead",
      title: "Else",
      name_history: JSON.stringify(["Shared"]),
      state: "ended",
    });
    // Two rows match "Shared"; exactly one is live → the live one wins.
    const r = resolveJob(db, { title: "shared" });
    expect(okRow(r).job_id).toBe("live");
  });

  test("malformed name_history blob does not throw the query", () => {
    seed({ job_id: "j1", title: "T", name_history: "{not json" });
    // The query must still run (json_each over the COALESCE'd column); the
    // current-title arm still matches.
    expect(okRow(resolveJob(db, { title: "t" })).job_id).toBe("j1");
  });
});

describe("resolveJob — cwd containment", () => {
  test("matches the root itself", () => {
    seed({ job_id: "j1", cwd: "/repo" });
    expect(okRow(resolveJob(db, { cwdRoot: "/repo" })).job_id).toBe("j1");
  });

  test("matches a path under the root", () => {
    seed({ job_id: "j1", cwd: "/repo/sub/dir" });
    expect(okRow(resolveJob(db, { cwdRoot: "/repo" })).job_id).toBe("j1");
  });

  test("boundary guard: /repo does NOT match /repo/foobar sibling /repofoo", () => {
    seed({ job_id: "inside", cwd: "/repo/foo" });
    seed({ job_id: "sibling", cwd: "/repofoo" });
    const r = resolveJob(db, { cwdRoot: "/repo" });
    expect(okRow(r).job_id).toBe("inside");
  });

  test("LIKE wildcards in the root are escaped (literal match)", () => {
    seed({ job_id: "j1", cwd: "/re%po/sub" });
    seed({ job_id: "other", cwd: "/reXpo/sub" });
    // Without escaping, `%` would let /reXpo match. It must not.
    const r = resolveJob(db, { cwdRoot: "/re%po" });
    expect(okRow(r).job_id).toBe("j1");
  });

  test("--cwd-exact does strict equality", () => {
    seed({ job_id: "exact", cwd: "/repo" });
    seed({ job_id: "under", cwd: "/repo/sub" });
    const r = resolveJob(db, { cwdExact: "/repo" });
    expect(okRow(r).job_id).toBe("exact");
  });
});

describe("resolveJob — paneIds (tmux window-scope predicate)", () => {
  test("matches a job whose pane is in the set", () => {
    seed({ job_id: "agent", backend_exec_pane_id: "%3", state: "working" });
    const r = resolveJob(db, { paneIds: ["%1", "%2", "%3"] });
    expect(okRow(r).job_id).toBe("agent");
  });

  test("no pane in the set → not_found", () => {
    seed({ job_id: "agent", backend_exec_pane_id: "%9" });
    expect(resolveJob(db, { paneIds: ["%1", "%2"] }).kind).toBe("not_found");
  });

  test("two live agents in the window → ambiguous", () => {
    seed({ job_id: "a", backend_exec_pane_id: "%1", state: "working" });
    seed({ job_id: "b", backend_exec_pane_id: "%2", state: "working" });
    const r = resolveJob(db, { paneIds: ["%1", "%2"] });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.length).toBe(2);
  });

  test("one live + one terminal in the window → the live one wins", () => {
    seed({ job_id: "live", backend_exec_pane_id: "%1", state: "working" });
    seed({ job_id: "dead", backend_exec_pane_id: "%2", state: "ended" });
    const r = resolveJob(db, { paneIds: ["%1", "%2"] });
    expect(okRow(r).job_id).toBe("live");
  });
});

describe("resolveJob — ambiguity rule", () => {
  test("0 matches → not_found", () => {
    expect(resolveJob(db, { title: "ghost" }).kind).toBe("not_found");
  });

  test("exactly 1 (terminal) IS returned — you can inspect a dead session", () => {
    seed({ job_id: "dead", title: "T", state: "killed" });
    expect(okRow(resolveJob(db, { title: "t" })).job_id).toBe("dead");
  });

  test(">1 with 0 live → ambiguous", () => {
    seed({ job_id: "d1", title: "Dup", state: "ended" });
    seed({ job_id: "d2", title: "Dup", state: "killed" });
    expect(resolveJob(db, { title: "dup" }).kind).toBe("ambiguous");
  });

  test(">1 with ≥2 live → ambiguous", () => {
    seed({ job_id: "l1", title: "Dup", state: "working" });
    seed({ job_id: "l2", title: "Dup", state: "stopped" });
    expect(resolveJob(db, { title: "dup" }).kind).toBe("ambiguous");
  });

  test("--latest collapses ambiguity to the deterministic-sort top", () => {
    // Both live → ambiguous without --latest; with it, the most-recent wins.
    seed({ job_id: "older", title: "Dup", state: "working", updated_at: 100 });
    seed({ job_id: "newer", title: "Dup", state: "working", updated_at: 200 });
    const r = resolveJob(db, { title: "dup", latest: true });
    expect(okRow(r).job_id).toBe("newer");
  });

  test("--latest never fabricates a result from not_found", () => {
    expect(resolveJob(db, { title: "ghost", latest: true }).kind).toBe(
      "not_found",
    );
  });

  test("ambiguous candidate list is deterministic (live first, recency, id)", () => {
    seed({ job_id: "zzz", title: "Dup", state: "ended", updated_at: 50 });
    seed({ job_id: "aaa", title: "Dup", state: "ended", updated_at: 50 });
    const r = resolveJob(db, { title: "dup" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      // Equal state + recency → job_id ASC final tiebreak.
      expect(r.candidates.map((c) => c.job_id)).toEqual(["aaa", "zzz"]);
    }
  });
});

describe("resolveJob — no effective filter", () => {
  test("empty selector set → not_found (total over no WHERE)", () => {
    seed({ job_id: "j1" });
    expect(resolveJob(db, {}).kind).toBe("not_found");
  });
});

describe("decodeFor — JSON-TEXT columns", () => {
  test("decodes name_history/epic_links/monitors; passthrough on --raw", () => {
    seed({
      job_id: "j1",
      title: "T",
      name_history: JSON.stringify(["a", "b"]),
    });
    const r = resolveJob(db, { jobId: "j1" });
    const row = okRow(r);
    const decoded = decodeFor(row, false);
    expect(decoded.name_history).toEqual(["a", "b"]);
    // epic_links / monitors default to '[]' TEXT → decoded to [].
    expect(decoded.epic_links).toEqual([]);
    expect(decoded.monitors).toEqual([]);
    const raw = decodeFor(row, true);
    expect(typeof raw.name_history).toBe("string");
  });

  test("malformed JSON-TEXT folds to [] (never throws)", () => {
    seed({ job_id: "j1", title: "T", name_history: "{bad" });
    const row = okRow(resolveJob(db, { jobId: "j1" }));
    expect(decodeFor(row, false).name_history).toEqual([]);
  });

  test("full row carries all jobs columns", () => {
    seed({ job_id: "j1", title: "T", cwd: "/x", state: "working" });
    const row = okRow(resolveJob(db, { jobId: "j1" }));
    // A representative spread of the DDL columns must all be present.
    for (const col of [
      "job_id",
      "created_at",
      "updated_at",
      "cwd",
      "state",
      "title",
      "name_history",
      "epic_links",
      "monitors",
      "backend_exec_pane_id",
      "active_since",
    ]) {
      expect(col in row).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope — the ResolveResult → shared one-shot envelope mapping. Proves
// success rides `data` and every failure rides `error.{code,message,recovery}`
// (String(e) eliminated), with the ambiguous candidate list on error.details.
// ---------------------------------------------------------------------------

describe("buildEnvelope: envelope mapping", () => {
  test("ok → data:{job,resolution}, ok:true, error:null", () => {
    seed({ job_id: "j1", title: "T", cwd: "/x", state: "working" });
    const env = buildEnvelope(resolveJob(db, { jobId: "j1" }), "job-id", false);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    const data = env.data as {
      job: Record<string, unknown>;
      resolution: Record<string, unknown>;
    };
    expect(data.job.job_id).toBe("j1");
    expect(data.resolution.method).toBe("job-id");
    expect(data.resolution.matched_field).toBe("job_id");
  });

  test("not_found → ok:false with a stable code + recovery, data:null", () => {
    const env = buildEnvelope({ kind: "not_found" }, "job-id", false);
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error?.code).toBe("not_found");
    expect(env.error?.recovery.length).toBeGreaterThan(0);
    // No raw String(e) / stack / path leak — a clean corrective message.
    expect(env.error?.message).not.toContain("/");
  });

  test("ambiguous → ok:false, code 'ambiguous', candidates on error.details", () => {
    seed({ job_id: "j1", state: "working", backend_exec_pane_id: "%1" });
    seed({ job_id: "j2", state: "working", backend_exec_pane_id: "%2" });
    const result = resolveJob(db, { paneIds: ["%1", "%2"] });
    expect(result.kind).toBe("ambiguous");
    const env = buildEnvelope(result, "pane", false);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("ambiguous");
    const details = env.error?.details as {
      candidates: Array<{ job_id: string }>;
    };
    expect(details.candidates.map((c) => c.job_id).sort()).toEqual([
      "j1",
      "j2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retired spellings — the selectors are --job-id and --session-title; the old
// --session-id and --session hard-fail (unknown argument → exit 2) at parse,
// before any keeper.db open.
// ---------------------------------------------------------------------------

describe("main: retired selector spellings hard-fail exit 2", () => {
  /** Drive show-job's main() capturing the exit code + stderr, patching the
   *  process globals it writes through directly. Parse dies before DB open. */
  function runMain(argv: string[]): { code: number | undefined; err: string } {
    const realExit = process.exit;
    const realErr = process.stderr.write.bind(process.stderr);
    let code: number | undefined;
    let err = "";
    process.exit = ((c?: number) => {
      code = c ?? 0;
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    process.stderr.write = ((s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      showJobMain(argv);
    } catch {
      // the patched process.exit throws to unwind — expected
    } finally {
      process.exit = realExit;
      process.stderr.write = realErr;
    }
    return { code, err };
  }

  for (const flag of ["--session-id", "--session"] as const) {
    test(`${flag} is a retired spelling → exit 2`, () => {
      const r = runMain([flag, "abc"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(flag);
    });
  }
});
