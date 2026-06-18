## Overview

Third epic of the Python→Bun migration: planctl-bun gains its first writes. The worker-loop verbs `init`, `claim`, `done`, `block` land on new shared machinery — byte-stable atomic JSON writes (recursive key sort, tmp+fsync+rename), the touched-paths session log, flock(2) task locks via bun:ffi that interop with Python's fcntl.flock, the mutating NDJSON envelope, and inline auto-commit at emit with byte-identical commit subjects/trailers. Hard wave boundary: no integrity.py, no validation-restamp, no epic-id lock, no scaffold/refine-apply. Both engines may now mutate the same `.planctl/` state concurrently — interop and byte parity are correctness requirements.

## Quick commands

- `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/test_cli.py tests/test_readonly_verbs.py tests/test_init.py tests/test_worker_verbs.py` — the scoped gate this epic must turn green
- `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/test_worker_verbs.py tests/test_init.py` — same tests against Python (proves the tests)
- `bun run test` — bun units incl. flock interop + golden serializer parity

## Acceptance

- [ ] `tests/test_worker_verbs.py` exists: engine-agnostic, seed_state-seeded conformance tests for claim/done/block (typed error envelopes, --force matrix, no-commit assertions for claim/block, done's commit subject/trailers and worker_done_at stamp under frozen PLANCTL_NOW) — green in default engine AND under PLANCTL_BIN at the Python planctl
- [ ] Scoped gate green against compiled dist/planctl-bun: test_cli.py, test_readonly_verbs.py, test_init.py (as-is, real_git), test_worker_verbs.py
- [ ] Cross-engine flock interop proven by bun:test units in both directions against a real python3 peer (marker-file sync, no sleeps)
- [ ] Golden cross-serializer test pins the bun file writer byte-identical to Python json.dumps(indent=2, sort_keys=True)+newline on a shared nested fixture
- [ ] claim and block produce ZERO commits; done and init produce commits byte-identical in subject and trailer shape to Python's
- [ ] Python fast gate + full Python conformance untouched and green; bun lint/typecheck/test green
- [ ] Docs revised in place: authority-statement verb list (drop the read-only qualifier), gate row paths/label in CLAUDE.md+AGENTS.md, README prerequisites/bun section

## Early proof point

Task that proves the approach: ordinal 2 (writer + flock + store write side). If bun:ffi flock proves unstable inside the compiled binary, fallback: keep the flock module API but back it with a spawned `python3 -c` flock helper as a temporary shim while upstream is investigated — same lock table, same interop, slower; the module seam isolates the swap.

## References

- Program: epic ③ of ~6 (fn-28, fn-29 closed; ④–⑤ heavy verbs + remaining reads; ⑥ cutover). Python sources are the executable spec.
- Commit/no-commit split (the wave's central structure): claim/block mutate only gitignored state/ → readonly emit (pretty primary + compact trailer, pattern in src/cli.ts); done rewrites tracked files → ONE compact NDJSON line with embedded planctl_invocation; init self-commits via a LITERAL payload (planctl/run_init.py:111-126 — no touched-log, no session id, commits only when files written AND inside a git work tree via find_git_root).
- Writer: planctl/_util.py:60-84 atomic_write (mkstemp same-dir, fsync, os.replace, parent-dir fsync, unlink on exception); planctl/store.py:113-116 atomic_write_json = json.dumps(indent=2, sort_keys=True)+newline — SORTED keys, unlike the stdout emitters; store.py:99-111 every write records a touched-path.
- Touched log: store.py:16-96 — CLAUDE_CODE_SESSION_ID fail-OPEN, one uuid4hex.txt per write under .planctl/state/sessions/<sid>/touched/, content = repo-relative POSIX path.
- Mutating invocation: planctl/invocation.py:43-137 — session id fail-CLOSED (RuntimeError), files = sorted(touched ∩ dirty), dirty probe `git status --porcelain --untracked-files=all -- .planctl/` (flag is load-bearing; match Python's non-z line[3:] parsing exactly), field order files/op/target/subject/touched_path_files/repo_root/state_repo/queue_jump/session_id.
- emit + commit: planctl/output.py:22-152 (commit BEFORE printing; CommitFailed → compact failure envelope exit 1, success envelope not printed); planctl/commit.py:270-399 (empty files → no-op; 8 attempts full-jitter 0.1 base 2.0 cap; retry ONLY on index.lock/File exists/cannot lock ref stderr; message = subject + Planctl-Op/Planctl-Target/Planctl-Prev-Op (+ Session-Id when present); prev sha sentinel "unknown" on fresh repo); subject planctl/commit_messages.py:22-28.
- Locks: planctl/store.py:207-219 lock_task — flock LOCK_EX on .planctl/state/locks/<task_id>.lock; claim/done/block all take it, init takes none.
- Verbs: planctl/run_claim.py (find_projects_with_task roots resolution, typed gates, CAS, brief write, work marker after CAS), run_done.py (lock: spec patch + runtime; after lock: worker_done_at on tracked JSON), run_block.py, run_init.py. Port deps: planctl/brief.py, planctl/specs.py, planctl/config.py load_roots + planctl/discovery.py subset, models.worker_agent_for_tier, ids is_task_id/epic_id_from_task.
- Conformance seeding: seed_state + run_cli only (seed_epic calls scaffold — not in this wave); pattern at tests/test_session_markers.py:221+. tests/test_init.py is conformance-eligible as-is (module-wide real_git). tests/test_commit.py assertions get ported into bun units (in-process Python unit tests, not engine-agnostic).
- Env discipline: the bun binary must HONOR inherited GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/PLANCTL_*/CLAUDE_CODE_SESSION_ID — the conformance harness rides them; never strip to a sanitized env for git spawns.

## Docs gaps

- **CLAUDE.md + AGENTS.md**: authority statement verb list grows; drop the read-only qualifier (no tombstone); gate row gains test_init.py + test_worker_verbs.py and a neutral label
- **README.md**: prerequisites bullet and bun section lose the read-only characterization; verb enumeration updated

## Best practices

- **Atomic writes:** node:fs tmp-in-same-dir + fsync + renameSync + parent-dir fsync; Bun.write is NOT atomic; tmp name carries pid+random; unlink tmp on any throw [write-file-atomic, LWN]
- **bun:ffi flock:** dlopen by name with platform candidates (darwin libc.dylib, linux libc.so.6 — never libc.so); fds via node:fs openSync (Bun.file GC fd corruption, bun#8687); hold the fd for the lock lifetime; EWOULDBLOCK 35 darwin / 11 linux [myco lifecycle-lock, mcp-cli flock]
- **Git spawning:** explicit cwd; honor ambient GIT_CONFIG_*; never inherit-or-set GIT_DIR/GIT_WORK_TREE; parse porcelain rename records ("a -> b") like Python [git docs]
- **JSON number parity:** JS collapses -0 and mangles ints >2^53; keep state values strings/ints and pin with the golden cross-serializer test [MDN/Python json docs]
- **Lock tests:** real peer process + marker-file sync, never sleep; serial/own group under xdist [pytest-xdist #668]
