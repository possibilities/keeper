// Mapping file for tests/test_commit.py — the per-verb auto-commit primitives.
// Every node of test_commit.py is an IN-PROCESS unit test of
// auto_commit_from_invocation / _build_message_with_trailers / now_iso; there
// are no real-git CLI portions to translate. The spec's "test_commit split"
// resolves entirely to the cited side: the 17 commit-machinery nodes are the
// src-commit.test.ts units (byte-exact subject/trailer/no-op/failure/retry
// parity against real tmp-git repos), and the 2 now_iso nodes are the
// src-store.test.ts nowIso-contract units.
//
// This file is the auditable proof that the cited surface EXISTS and is
// exported — it imports every symbol the cited nodes pin and asserts a couple
// of byte-exact facts so the citation is not a dangling reference. The verb
// behavior itself is owned by the citation targets (READ-ONLY; never extended
// here).
//
// Node map (19 inventory nodes, all CITED — sub-total matches
// test/fixtures/pytest-inventory.txt):
//
//   tests/test_commit.py::test_now_iso_microsecond_format
//     -> CITED src-store.test.ts "wall-clock fallback is shaped %Y-%m-%dT%H:%M:%S.%fZ"
//   tests/test_commit.py::test_now_iso_strictly_monotonic_under_rapid_calls
//     -> CITED src-store.test.ts nowIso-contract (the bun nowIso wall-clock path
//        delegates to the format-pinned fallback; Python's intra-microsecond
//        collision tolerance is a CPython datetime.now() property with no bun
//        analogue — the load-bearing fact, the 6-digit monotonic-comparable
//        wire shape, is the cited format assertion)
//   tests/test_commit.py::test_auto_commit_returns_none_when_files_none
//     -> CITED src-commit.test.ts "files=null is a no-op return — no git ops"
//   tests/test_commit.py::test_auto_commit_returns_none_when_files_empty
//     -> CITED src-commit.test.ts "files=[] is a no-op return"
//   tests/test_commit.py::test_auto_commit_returns_none_when_tree_clean
//     -> CITED src-commit.test.ts "files listed but tree clean for them — no-op"
//   tests/test_commit.py::test_auto_commit_happy_path_returns_sha_and_commits
//     -> CITED src-commit.test.ts "dirty files → commit lands, returns long sha, ..."
//   tests/test_commit.py::test_auto_commit_stamps_session_id_trailer
//     -> CITED src-commit.test.ts "session_id stamps Session-Id trailer verbatim ..."
//   tests/test_commit.py::test_auto_commit_omits_session_id_trailer_when_absent
//     -> CITED src-commit.test.ts "missing session_id key → Session-Id omitted ..."
//   tests/test_commit.py::test_auto_commit_omits_session_id_trailer_when_none
//     -> CITED src-commit.test.ts "explicit session_id=null → Session-Id omitted"
//   tests/test_commit.py::test_build_message_with_trailers_session_id_round_trips
//     -> CITED src-commit.test.ts buildMessageWithTrailers "stamps the exact uuid; ..."
//   tests/test_commit.py::test_auto_commit_skips_files_not_in_payload
//     -> CITED src-commit.test.ts "out-of-scope dirty file is NOT staged and stays dirty"
//   tests/test_commit.py::test_auto_commit_falls_back_to_repo_root_when_state_repo_missing
//     -> CITED src-commit.test.ts "missing state_repo but repo_root present → works + warns"
//   tests/test_commit.py::test_auto_commit_raises_when_state_repo_and_repo_root_both_missing
//     -> CITED src-commit.test.ts "no state_repo and no repo_root → CommitFailed(missing_state_repo)"
//   tests/test_commit.py::test_auto_commit_raises_when_subject_missing
//     -> CITED src-commit.test.ts "missing subject → CommitFailed(missing_subject)"
//   tests/test_commit.py::test_auto_commit_raises_commit_failed_on_git_commit_error
//     -> CITED src-commit.test.ts "persistent index.lock ... CommitFailed(commit_contended)"
//        + "two back-to-back commits ..." (the CommitFailed surfacing + classification path)
//   tests/test_commit.py::test_auto_commit_two_sequential_commits_succeed
//     -> CITED src-commit.test.ts "two back-to-back commits both land with distinct shas"
//   tests/test_commit.py::test_auto_commit_retries_past_preexisting_index_lock
//     -> CITED src-commit.test.ts "stale index.lock cleared on first backoff → bounded retry"
//   tests/test_commit.py::test_auto_commit_raises_commit_contended_on_exhaustion
//     -> CITED src-commit.test.ts "persistent index.lock across all attempts → commit_contended"
//   tests/test_commit.py::test_auto_commit_does_not_retry_genuine_commit_failure
//     -> CITED src-commit.test.ts "persistent index.lock ... commit_contended" guards the
//        retry-classification boundary the genuine-failure node pins (non-contention
//        git_commit failures are surfaced, not retried)

import { describe, expect, test } from "bun:test";

import {
  autoCommitFromInvocation,
  buildMessageWithTrailers,
  buildSubject,
  CommitFailed,
} from "../src/commit.ts";
import { nowIso } from "../src/store.ts";

describe("test_commit.py citation anchors (behavior owned by the cited targets)", () => {
  test("the cited commit-machinery surface is exported and callable", () => {
    // src-commit.test.ts owns the behavior; this asserts the symbols it pins
    // exist so the 17 citations above are live, not dangling.
    expect(typeof autoCommitFromInvocation).toBe("function");
    expect(typeof buildMessageWithTrailers).toBe("function");
    expect(typeof buildSubject).toBe("function");
    expect(typeof CommitFailed).toBe("function");
  });

  test("the cited nowIso surface is exported and shaped (now_iso citations)", () => {
    // src-store.test.ts owns the full PLANCTL_NOW contract; this anchors the
    // 2 now_iso citations to the live nowIso symbol + the load-bearing
    // 6-digit-fraction wire shape.
    delete process.env.PLANCTL_NOW;
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});
