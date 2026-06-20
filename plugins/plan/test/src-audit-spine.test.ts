// Unit tests for the close-phase audit/submit/verdict spine — the byte-parity
// port of planctl/audit_artifacts.py + submit_common.py + verdict_schema.py.
//
// Three load-bearing parity proofs:
//   1. computeCommitSetHash byte-identical to the frozen serialization spec: the
//      digests below were captured from compute_commit_set_hash and pinned as
//      the executable spec (canonical order-independent SHA-256, schema_version
//      folded); a drift in either direction breaks the byte-parity assertion.
//   2. validateVerdict reproduces every golden VERDICT_INVALID envelope from
//      test/fixtures/golden/verdict/ — the {loc,type,msg} parity table whose
//      message text is the load-bearing surface, pinned by the frozen corpus.
//   3. writeArtifact is COMMIT-FREE and touched-log-free: it lands the file but
//      records NOTHING under sessions/<sid>/touched (unlike store.atomicWrite),
//      so the next mutating verb's auto-commit never sweeps an audit artifact.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ArtifactSchemaTooNewError,
  AUDIT_SCHEMA_VERSION,
  auditDir,
  auditsRoot,
  briefPath,
  type CommitGroup,
  computeCommitSetHash,
  followupPath,
  readArtifactJson,
  reportMetaPath,
  reportPath,
  setAuditSchemaVersion,
  verdictPath,
  writeArtifact,
  writeBriefArtifact,
} from "../src/audit_artifacts.ts";
import { validateVerdict } from "../src/verdict_schema.ts";

const GOLDEN_DIR = join(import.meta.dir, "fixtures", "golden", "verdict");

describe("computeCommitSetHash byte-parity with the frozen hash spec", () => {
  const fixtures: { name: string; groups: CommitGroup[]; hash: string }[] = [
    {
      name: "empty set",
      groups: [],
      hash: "1d9ebf5514067028b750fb8f1ec6dff67d94515b5224186200ee4331f6d2a029",
    },
    {
      name: "single repo, single sha",
      groups: [{ repo: "/r/primary", shas: ["abc123"] }],
      hash: "37d6b72141ae822db9cc23be33f360875f520d1c8982d1e6ccacfc43e1480b5f",
    },
    {
      name: "order-independent: unsorted shas + repos",
      groups: [
        { repo: "/r/b", shas: ["ffee", "0011", "aa99"] },
        { repo: "/r/a", shas: ["dead", "beef"] },
      ],
      hash: "e0dad6bdba0aefcd477dd4c31bed9221a813940362b71555e00e680b30781f99",
    },
    {
      name: "duplicate shas collapse",
      groups: [{ repo: "/r/x", shas: ["aa", "aa", "bb", "aa"] }],
      hash: "7d2ad269901968b7f33aaebcee10295fc31dc0554882d3d8abd8725777c8eb0a",
    },
    {
      name: "null / missing shas → empty",
      groups: [{ repo: "/r/p", shas: null }, { repo: "/r/q" }],
      hash: "270b913eee4ddb10097102bebe387df2744c7912e93f46c072005076d0c3ba42",
    },
  ];

  for (const { name, groups, hash } of fixtures) {
    test(name, () => {
      expect(computeCommitSetHash(groups)).toBe(hash);
    });
  }

  test("repo iteration order does not change the hash (set semantics)", () => {
    const a: CommitGroup[] = [
      { repo: "/r/a", shas: ["1", "2"] },
      { repo: "/r/b", shas: ["3"] },
    ];
    const b: CommitGroup[] = [
      { repo: "/r/b", shas: ["3"] },
      { repo: "/r/a", shas: ["2", "1"] },
    ];
    expect(computeCommitSetHash(a)).toBe(computeCommitSetHash(b));
  });

  test("input is not mutated (display order preserved)", () => {
    const groups: CommitGroup[] = [{ repo: "/r/z", shas: ["cc", "aa", "bb"] }];
    computeCommitSetHash(groups);
    expect(groups[0]?.shas).toEqual(["cc", "aa", "bb"]);
  });

  test("schema_version is folded in: a bump invalidates the hash", () => {
    const groups: CommitGroup[] = [{ repo: "/r/p", shas: ["abc"] }];
    const before = computeCommitSetHash(groups);
    setAuditSchemaVersion(AUDIT_SCHEMA_VERSION + 1);
    try {
      expect(computeCommitSetHash(groups)).not.toBe(before);
    } finally {
      setAuditSchemaVersion(1);
    }
  });
});

describe("validateVerdict vs the golden corpus", () => {
  const goldens = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"));

  test("corpus is non-empty (fixtures present)", () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  for (const file of goldens) {
    test(`${file}: envelope matches the frozen golden`, () => {
      const golden = JSON.parse(
        readFileSync(join(GOLDEN_DIR, file), "utf-8"),
      ) as { input: unknown; envelope: unknown };
      const got = validateVerdict(golden.input);
      expect(got).not.toBeNull();
      expect(got).toEqual(golden.envelope as never);
    });
  }

  test("a structurally + cross-field valid verdict yields null", () => {
    const valid = {
      fatal: false,
      fatal_reason: "",
      decisions: [
        { fid: "f1", action: "kept", task: 1, rationale: "r" },
        { fid: "f2", action: "culled", task: null, rationale: "r" },
        { fid: "f3", action: "merged-into-f1", task: 2, rationale: "r" },
      ],
    };
    expect(validateVerdict(valid)).toBeNull();
  });

  test("bool task is rejected as a non-integer ordinal (kept)", () => {
    const v = {
      fatal: false,
      fatal_reason: "",
      decisions: [{ fid: "f1", action: "kept", task: true, rationale: "r" }],
    };
    const env = validateVerdict(v);
    // bool fails the structural [integer,null] type check first.
    expect(env?.error.code).toBe("VERDICT_INVALID");
    expect(env?.error.details.errors[0]?.loc).toBe("decisions[0].task");
  });
});

describe("audit artifact path helpers", () => {
  let root: string;

  function setup(): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-audit-")));
    return root;
  }
  function teardown(): void {
    rmSync(root, { recursive: true, force: true });
  }

  test("auditsRoot defaults to <primary>/.keeper/state/audits on a fresh tree (pure path)", () => {
    const primary = setup();
    try {
      expect(auditsRoot(primary)).toBe(
        join(primary, ".keeper", "state", "audits"),
      );
      // pure path: not created
      expect(existsSync(auditsRoot(primary))).toBe(false);
    } finally {
      teardown();
    }
  });

  test("auditDir creates the tree at 0700 on both levels, idempotently", () => {
    const primary = setup();
    try {
      const dir = auditDir(primary, "fn-9-x");
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(auditsRoot(primary)).mode & 0o777).toBe(0o700);
      // idempotent re-call
      expect(auditDir(primary, "fn-9-x")).toBe(dir);
    } finally {
      teardown();
    }
  });

  test("brief/report/meta/verdict/followup paths land under the epic dir", () => {
    const primary = setup();
    try {
      const epic = "fn-9-x";
      const base = join(auditsRoot(primary), epic);
      expect(briefPath(primary, epic)).toBe(join(base, "brief.json"));
      expect(reportPath(primary, epic)).toBe(join(base, "report.md"));
      expect(reportMetaPath(primary, epic)).toBe(
        join(base, "report.meta.json"),
      );
      expect(verdictPath(primary, epic)).toBe(join(base, "verdict.json"));
      expect(followupPath(primary, epic)).toBe(join(base, "followup.yaml"));
    } finally {
      teardown();
    }
  });
});

describe("writeArtifact is commit-free and touched-log-free", () => {
  let repoRoot: string;
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;

  function setup(): { repoRoot: string; dataDir: string } {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "planctl-art-repo-")));
    const dataDir = join(repoRoot, ".keeper");
    mkdirSync(dataDir, { recursive: true });
    return { repoRoot, dataDir };
  }
  function teardown(): void {
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedSid === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    } else {
      process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    }
  }

  test("writes the file at 0600 and records NO touched-path", () => {
    const { repoRoot: rr, dataDir } = setup();
    try {
      // A live session id would make store.atomicWrite touch-log; writeArtifact
      // must NOT, even with one set.
      process.env.CLAUDE_CODE_SESSION_ID = "sess-art";
      const dest = writeArtifact(briefPath(rr, "fn-9-x"), '{"k":1}\n');
      expect(readFileSync(dest, "utf-8")).toBe('{"k":1}\n');
      expect(statSync(dest).mode & 0o777).toBe(0o600);

      // The decisive assertion: no touched-paths log entry was created.
      const sessions = join(dataDir, "state", "sessions");
      expect(existsSync(sessions)).toBe(false);
    } finally {
      teardown();
    }
  });

  test("no .tmp residue survives a successful write", () => {
    const { repoRoot: rr } = setup();
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const dest = writeArtifact(verdictPath(rr, "fn-9-x"), "{}\n");
      const leftover = readdirSync(dirname(dest)).filter((f) =>
        f.endsWith(".tmp"),
      );
      expect(leftover).toEqual([]);
    } finally {
      teardown();
    }
  });

  test("writeBriefArtifact serializes sorted-key + indent2 + newline", () => {
    const { repoRoot: rr } = setup();
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const dest = writeBriefArtifact(rr, "fn-9-x", { z: 1, a: 2 });
      expect(readFileSync(dest, "utf-8")).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
    } finally {
      teardown();
    }
  });
});

describe("readArtifactJson schema gate", () => {
  let root: string;

  test("missing file → null", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-read-")));
    try {
      expect(readArtifactJson(join(root, "nope.json"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("too-new schema_version → ArtifactSchemaTooNewError", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-read-")));
    try {
      const p = join(root, "a.json");
      writeFileSync(
        p,
        JSON.stringify({ schema_version: AUDIT_SCHEMA_VERSION + 5 }),
      );
      expect(() => readArtifactJson(p)).toThrow(ArtifactSchemaTooNewError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("known schema_version → parsed object", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-read-")));
    try {
      const p = join(root, "a.json");
      writeFileSync(p, JSON.stringify({ schema_version: 1, k: "v" }));
      expect(readArtifactJson(p)).toEqual({ schema_version: 1, k: "v" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
