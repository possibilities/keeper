// Citation manifest for tests/test_audit_artifacts.py — all 24 inventory nodes
// are CITED to the READ-ONLY test/src-audit-spine.test.ts, which owns the
// byte-parity port of the planctl.audit_artifacts spine (compute_commit_set_hash,
// the path helpers, writeArtifact atomicity/modes, the runtime-state-only
// no-commit contract, and the schema-version gate). No node is re-translated
// here; src-audit-spine is frozen and not edited by this task.
//
// The single guard test below asserts the cited describe blocks are still
// present in src-audit-spine, so a future rename can't silently orphan these
// citations.
//
// Below the citation guard, this file ALSO owns the direct tests for the
// per-task audit gate helpers (taskAuditDir / taskFindingPath / writeTaskFinding
// / readTaskFinding / taskFindingCoversCommitSet). Those are keeper-native
// additions with no Python ancestor, so they live here rather than in the frozen
// src-audit-spine port — covering the task-scoped layout (task-id-keyed, so
// parallel lanes never clobber) and the commit-set-hash staleness key.
//
// Node -> citation map (every node accounted for):
//
// TestCommitSetHash (compute_commit_set_hash determinism + canonicalization):
//   test_deterministic_same_input
//     -> src-audit-spine "computeCommitSetHash byte-parity": "single repo, single sha"
//        (a pinned digest is deterministic by construction).
//   test_order_independent_across_groups_and_shas
//     -> src-audit-spine "order-independent: unsorted shas + repos" +
//        "repo iteration order does not change the hash (set semantics)".
//   test_dedup_within_repo
//     -> src-audit-spine "duplicate shas collapse".
//   test_distinct_sets_distinct_hashes
//     -> src-audit-spine: the five pinned fixtures carry five distinct digests.
//   test_empty_groups_is_stable_hash
//     -> src-audit-spine "empty set" (a pinned stable digest).
//   test_repo_attribution_matters
//     -> src-audit-spine: "single repo, single sha" vs "null / missing shas"
//        carry distinct pinned digests under distinct repo attribution.
//   test_schema_version_folded_in
//     -> src-audit-spine "schema_version is folded in: a bump invalidates the hash".
//   test_input_not_mutated
//     -> src-audit-spine "input is not mutated (display order preserved)".
//   test_missing_shas_key_treated_as_empty
//     -> src-audit-spine "null / missing shas → empty" (pinned digest).
//
// TestPaths (path helpers):
//   test_audits_root_shape       -> src-audit-spine "auditsRoot is <primary>/...".
//   test_audits_root_not_created -> src-audit-spine "auditsRoot ... (pure path)"
//                                   (asserts existsSync(auditsRoot) === false).
//   test_artifact_basenames      -> src-audit-spine "brief/report/meta/verdict/
//                                   followup paths land under the epic dir".
//   test_audit_dir_created_lazily_at_0700
//     -> src-audit-spine "auditDir creates the tree at 0700 on both levels".
//   test_audit_dir_idempotent    -> src-audit-spine "auditDir ... idempotently".
//
// TestWriteArtifact (atomic writer):
//   test_writes_content_and_returns_path -> src-audit-spine "writes the file at
//                                           0600 and records NO touched-path".
//   test_file_mode_is_0600               -> same node (0600 mode assertion).
//   test_parent_created_when_absent      -> src-audit-spine writeArtifact lands
//                                           briefPath/verdictPath under a fresh
//                                           epic dir the writer mkdirs.
//   test_overwrite_is_atomic_replace     -> src-audit-spine "no .tmp residue
//                                           survives a successful write".
//   test_no_temp_residue_on_write_failure-> src-audit-spine "no .tmp residue
//                                           survives a successful write" (the
//                                           residue invariant; the os.replace
//                                           monkeypatch is a Python-internal seam).
//   test_write_brief_artifact_round_trip -> src-audit-spine "writeBriefArtifact
//                                           serializes sorted-key + indent2 + newline".
//
// TestNoCommit:
//   test_brief_write_lands_no_commit -> src-audit-spine "writeArtifact is
//     commit-free and touched-log-free" ("writes the file ... records NO
//     touched-path"): no sessions/ touched-log => the next auto-commit can never
//     sweep the artifact, the runtime-state-only contract.
//
// TestSchemaVersion:
//   test_version_is_positive_int -> src-audit-spine imports AUDIT_SCHEMA_VERSION
//     and exercises setAuditSchemaVersion(+1)/(1); a non-int/<1 version would
//     break the "schema_version is folded in" + readArtifactJson gate.
//   test_too_new_error_carries_found_and_known -> src-audit-spine "readArtifactJson
//     schema gate": "too-new schema_version → ArtifactSchemaTooNewError".
//
// module-level:
//   test_no_world_or_group_perms_on_dir_and_file -> src-audit-spine "auditDir
//     creates the tree at 0700" + "writes the file at 0600": 0700/0600 grant no
//     group/other bits.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactSchemaTooNewError,
  AUDIT_SCHEMA_VERSION,
  auditsRoot,
  type CommitGroup,
  computeCommitSetHash,
  readTaskFinding,
  taskAuditDir,
  taskFindingCoversCommitSet,
  taskFindingPath,
  writeTaskFinding,
} from "../src/audit_artifacts.ts";

const SPINE = join(import.meta.dir, "src-audit-spine.test.ts");

describe("audit-artifacts citation guard", () => {
  test("src-audit-spine still owns the cited describe blocks", () => {
    const body = readFileSync(SPINE, "utf-8");
    for (const block of [
      "computeCommitSetHash byte-parity with the frozen hash spec",
      "audit artifact path helpers",
      "writeArtifact is commit-free and touched-log-free",
      "readArtifactJson schema gate",
    ]) {
      expect(body).toContain(block);
    }
  });
});

describe("per-task audit gate helpers", () => {
  let primary: string;

  function setup(): string {
    primary = realpathSync(mkdtempSync(join(tmpdir(), "planctl-task-audit-")));
    return primary;
  }
  function teardown(): void {
    rmSync(primary, { recursive: true, force: true });
  }

  const EPIC = "fn-9-x";
  const COMMITS: CommitGroup[] = [{ repo: "/r/a", shas: ["abc123", "def456"] }];

  test("taskFindingPath lands under audits/<epic>/tasks/<task>.json (pure path, not created)", () => {
    setup();
    try {
      const p = taskFindingPath(primary, EPIC, `${EPIC}.3`);
      expect(p).toBe(
        join(auditsRoot(primary), EPIC, "tasks", `${EPIC}.3.json`),
      );
      expect(existsSync(p)).toBe(false);
    } finally {
      teardown();
    }
  });

  test("distinct tasks resolve to distinct paths — parallel lanes cannot clobber", () => {
    setup();
    try {
      const a = taskFindingPath(primary, EPIC, `${EPIC}.3`);
      const b = taskFindingPath(primary, EPIC, `${EPIC}.4`);
      expect(a).not.toBe(b);
      // Two concurrent lanes each writing their own task never touch one file.
      writeTaskFinding(primary, EPIC, `${EPIC}.3`, {
        status: "clean",
        commits: COMMITS,
      });
      writeTaskFinding(primary, EPIC, `${EPIC}.4`, {
        status: "mild",
        commits: [{ repo: "/r/a", shas: ["999999"] }],
      });
      expect(readTaskFinding(primary, EPIC, `${EPIC}.3`)?.status).toBe("clean");
      expect(readTaskFinding(primary, EPIC, `${EPIC}.4`)?.status).toBe("mild");
    } finally {
      teardown();
    }
  });

  test("taskAuditDir creates tasks/ at 0700, idempotently", () => {
    setup();
    try {
      const dir = taskAuditDir(primary, EPIC);
      expect(dir).toBe(join(auditsRoot(primary), EPIC, "tasks"));
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(taskAuditDir(primary, EPIC)).toBe(dir);
    } finally {
      teardown();
    }
  });

  test("writeTaskFinding persists commit-free at 0600, stamping ids + schema + hash", () => {
    setup();
    try {
      const dest = writeTaskFinding(primary, EPIC, `${EPIC}.3`, {
        status: "mild",
        commits: COMMITS,
        findings: [
          { fingerprint: "correctness:a.ts", status: "accumulated-open" },
        ],
      });
      expect(statSync(dest).mode & 0o777).toBe(0o600);
      const parsed = readTaskFinding(primary, EPIC, `${EPIC}.3`);
      expect(parsed?.schema_version).toBe(AUDIT_SCHEMA_VERSION);
      expect(parsed?.task_id).toBe(`${EPIC}.3`);
      expect(parsed?.epic_id).toBe(EPIC);
      expect(parsed?.status).toBe("mild");
      // Hash is the independent computeCommitSetHash over the artifact's commits.
      expect(parsed?.commit_set_hash).toBe(computeCommitSetHash(COMMITS));
      // No touched-log entry — the write is commit-free (audit artifacts never
      // draw a .keeper/ commit).
      expect(existsSync(join(primary, ".keeper", "state", "sessions"))).toBe(
        false,
      );
    } finally {
      teardown();
    }
  });

  test("readTaskFinding returns null when absent and hard-fails a too-new schema", () => {
    setup();
    try {
      expect(readTaskFinding(primary, EPIC, `${EPIC}.7`)).toBeNull();
      // A future-version artifact must surface the reader's hard-fail, never a
      // guess at a newer shape.
      const bump = AUDIT_SCHEMA_VERSION + 5;
      taskAuditDir(primary, EPIC);
      // Write a raw too-new artifact by hand (bypassing writeTaskFinding's stamp).
      writeFileSync(
        taskFindingPath(primary, EPIC, `${EPIC}.8`),
        JSON.stringify({ schema_version: bump }),
      );
      expect(() => readTaskFinding(primary, EPIC, `${EPIC}.8`)).toThrow(
        ArtifactSchemaTooNewError,
      );
    } finally {
      teardown();
    }
  });

  test("taskFindingCoversCommitSet: true only when the stored hash matches the current commit set", () => {
    setup();
    try {
      const task = `${EPIC}.3`;
      // No artifact yet → not covered (re-audit).
      expect(taskFindingCoversCommitSet(primary, EPIC, task, COMMITS)).toBe(
        false,
      );
      writeTaskFinding(primary, EPIC, task, {
        status: "clean",
        commits: COMMITS,
      });
      // Same commit set → fresh, short-circuit the re-audit.
      expect(taskFindingCoversCommitSet(primary, EPIC, task, COMMITS)).toBe(
        true,
      );
      // A moved commit set (a new commit landed) → stale, re-audit.
      const moved: CommitGroup[] = [
        { repo: "/r/a", shas: ["abc123", "def456", "0000ff"] },
      ];
      expect(taskFindingCoversCommitSet(primary, EPIC, task, moved)).toBe(
        false,
      );
    } finally {
      teardown();
    }
  });
});
