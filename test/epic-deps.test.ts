/**
 * epic-deps unit tests — guard the fold-safety contract on the leaf
 * resolver (`resolveEpicDep`). The broader resolver behavior (full-id miss,
 * bare-id miss, ambiguity, cwd-first disambig, cross-project) is already
 * exercised end-to-end by `test/readiness.test.ts` and `test/board.test.ts`;
 * this file's scope is narrow and intentional: prove that the resolver
 * NEVER reads wall-clock time and that the injected `now` parameter flows
 * straight into the diagnostic row.
 *
 * Without this guarantee, fn-637.3 cannot move the resolver into the
 * reducer fold — a fold that read `Date.now()` would re-fold to a
 * different byte-sequence on each replay.
 */

import { describe, expect, test } from "bun:test";
import { resolveEpicDep } from "../src/epic-deps";
import type { ResolutionDiagnostic } from "../src/readiness-diagnostics";
import type { Epic } from "../src/types";

function makeEpic(overrides: Partial<Epic>): Epic {
  return {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    question: null,
    ...overrides,
  };
}

describe("resolveEpicDep — fold-safe `now` injection", () => {
  test("ambiguous-dep-resolution row stamps the injected `now` verbatim", () => {
    // Two `fn-2` epics in projects that DON'T match the consumer's basename
    // → 2+ matches, no same-project disambiguator → ambiguous. The resolver
    // emits one diagnostic row whose `ts` field MUST equal the caller's
    // `now` arg byte-for-byte (no wall-clock read inside the resolver).
    const a = makeEpic({
      epic_id: "fn-2-aaa",
      epic_number: 2,
      project_dir: "/Users/mike/code/arthack",
    });
    const b = makeEpic({
      epic_id: "fn-2-zzz",
      epic_number: 2,
      project_dir: "/Users/mike/code/otherproj",
    });
    const consumer = makeEpic({
      epic_id: "fn-1-foo",
      depends_on_epics: ["fn-2"],
    });
    const epicById = new Map<string, Epic>([
      [a.epic_id, a],
      [b.epic_id, b],
      [consumer.epic_id, consumer],
    ]);
    const epicsByNumber = new Map<number, Epic[]>([
      [2, [a, b]],
      [1, [consumer]],
    ]);

    const NOW = "1999-12-31T23:59:59.000Z";
    const diagnostics: ResolutionDiagnostic[] = [];
    const got = resolveEpicDep(
      "fn-2",
      consumer,
      epicById,
      epicsByNumber,
      diagnostics,
      NOW,
    );

    expect(got).toEqual({ kind: "dangling" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.ts).toBe(NOW);
    expect(diagnostics[0]?.kind).toBe("ambiguous-dep-resolution");
    expect(diagnostics[0]?.consumer_epic).toBe("fn-1-foo");
    expect(diagnostics[0]?.upstream).toBe("fn-2");
    // Matches sorted — already covered in readiness.test.ts but re-asserted
    // here because re-fold determinism rides on that sort too.
    expect(diagnostics[0]?.matches).toEqual(["fn-2-aaa", "fn-2-zzz"]);
  });

  test("two calls with identical inputs and identical `now` produce byte-identical diagnostics", () => {
    // Determinism guard: the resolver's diagnostic row is a pure function
    // of the inputs (including the injected `now`). Without the injection,
    // a back-to-back replay would yield diagnostics whose `ts` fields
    // diverged by the elapsed wall-clock time between calls — exactly the
    // failure mode fn-637.3's re-fold byte-identity test would trip on.
    const a = makeEpic({
      epic_id: "fn-2-aaa",
      epic_number: 2,
      project_dir: "/Users/mike/code/arthack",
    });
    const b = makeEpic({
      epic_id: "fn-2-zzz",
      epic_number: 2,
      project_dir: "/Users/mike/code/otherproj",
    });
    const consumer = makeEpic({
      epic_id: "fn-1-foo",
      depends_on_epics: ["fn-2"],
    });
    const epicById = new Map<string, Epic>([
      [a.epic_id, a],
      [b.epic_id, b],
      [consumer.epic_id, consumer],
    ]);
    const epicsByNumber = new Map<number, Epic[]>([[2, [a, b]]]);

    const NOW = "2026-05-28T12:00:00.000Z";
    const d1: ResolutionDiagnostic[] = [];
    const d2: ResolutionDiagnostic[] = [];
    resolveEpicDep("fn-2", consumer, epicById, epicsByNumber, d1, NOW);
    resolveEpicDep("fn-2", consumer, epicById, epicsByNumber, d2, NOW);

    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });

  test("non-ambiguous resolution never reads `now` (no diagnostic emitted)", () => {
    // Sanity: a single-match bare id resolves cleanly without pushing a
    // diagnostic, regardless of what `now` is — the resolver only consults
    // `now` on the ambiguity branch. Passing a deliberately bogus `now`
    // and asserting the diagnostics sink stays empty proves the branch
    // gate.
    const upstream = makeEpic({
      epic_id: "fn-2-only",
      epic_number: 2,
      project_dir: "/Users/mike/code/keeper",
    });
    const consumer = makeEpic({
      epic_id: "fn-1-foo",
      depends_on_epics: ["fn-2"],
    });
    const epicById = new Map<string, Epic>([
      [upstream.epic_id, upstream],
      [consumer.epic_id, consumer],
    ]);
    const epicsByNumber = new Map<number, Epic[]>([[2, [upstream]]]);

    const diagnostics: ResolutionDiagnostic[] = [];
    const got = resolveEpicDep(
      "fn-2",
      consumer,
      epicById,
      epicsByNumber,
      diagnostics,
      "this-should-never-surface",
    );

    expect(got.kind).toBe("found");
    expect(diagnostics).toHaveLength(0);
  });
});
