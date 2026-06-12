// Unit tests for the close-phase audit/submit/verdict spine — the byte-parity
// port of planctl/audit_artifacts.py + submit_common.py + verdict_schema.py.
//
// Three load-bearing parity proofs:
//   1. computeCommitSetHash byte-identical to compute_commit_set_hash: a python3
//      peer imports the real module and hashes the SAME fixture; the digests
//      must match (canonical order-independent SHA-256, schema_version folded).
//   2. validateVerdict reproduces every golden VERDICT_INVALID envelope from
//      tests/fixtures/golden/verdict/ — the {loc,type,msg} parity table whose
//      message text is the load-bearing surface (python-jsonschema's wording).
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

const GOLDEN_DIR = join(
  import.meta.dir,
  "..",
  "tests",
  "fixtures",
  "golden",
  "verdict",
);

/** Hash `commitGroups` through a python3 peer that imports the REAL
 * planctl.audit_artifacts.compute_commit_set_hash — the executable spec the bun
 * hash is held to. Runs from the repo root so the package is importable. */
function pythonCommitSetHash(commitGroups: CommitGroup[]): string {
  const script =
    "import json,sys; " +
    "from planctl.audit_artifacts import compute_commit_set_hash; " +
    "sys.stdout.write(compute_commit_set_hash(json.load(sys.stdin)))";
  const proc = Bun.spawnSync(["uv", "run", "python3", "-c", script], {
    cwd: join(import.meta.dir, ".."),
    stdin: Buffer.from(JSON.stringify(commitGroups)),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`python3 hash failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

describe("computeCommitSetHash byte-parity with Python", () => {
  const fixtures: { name: string; groups: CommitGroup[] }[] = [
    { name: "empty set", groups: [] },
    {
      name: "single repo, single sha",
      groups: [{ repo: "/r/primary", shas: ["abc123"] }],
    },
    {
      name: "order-independent: unsorted shas + repos",
      groups: [
        { repo: "/r/b", shas: ["ffee", "0011", "aa99"] },
        { repo: "/r/a", shas: ["dead", "beef"] },
      ],
    },
    {
      name: "duplicate shas collapse",
      groups: [{ repo: "/r/x", shas: ["aa", "aa", "bb", "aa"] }],
    },
    {
      name: "null / missing shas → empty",
      groups: [{ repo: "/r/p", shas: null }, { repo: "/r/q" }],
    },
  ];

  for (const { name, groups } of fixtures) {
    test(name, () => {
      expect(computeCommitSetHash(groups)).toBe(pythonCommitSetHash(groups));
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
    test(`${file}: envelope matches python-jsonschema parity`, () => {
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

  test("auditsRoot is <primary>/.planctl/state/audits (pure path)", () => {
    const primary = setup();
    try {
      expect(auditsRoot(primary)).toBe(
        join(primary, ".planctl", "state", "audits"),
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
    const dataDir = join(repoRoot, ".planctl");
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
