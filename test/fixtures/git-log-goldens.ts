/**
 * Golden `git log -z --format=COMMIT_LOG_FORMAT` and `git diff-tree -z` byte
 * strings CAPTURED FROM REAL GIT ONCE (never hand-authored — see the epic spec's
 * Pantera convention). `test/git-worker.test.ts` feeds these to the PURE parsers
 * `enumerateCommitsFromLog` / `parseCommitFiles` so the suite validates the
 * stride parser against a real git sample without spawning git on every run.
 *
 * `\x00` is the literal NUL the `%x00` format separators + `-z` emit (written as
 * `\x00`, not `\0`, so a following digit is not parsed as an octal escape); `\n`
 * is the default Task-trailer block separator. To re-capture (e.g. after a
 * COMMIT_LOG_FORMAT change), re-run the one-shot capture against real git and
 * re-paste — DO NOT edit these strings by hand, or the parser would validate
 * against a fabrication.
 *
 * Field stride per commit (8 NUL-delimited fields, COMMIT_LOG_FORMAT order):
 *   OID, %P (parents), %ct (commit time), Session-Id, Job-Id, Task,
 *   Planctl-Op, Planctl-Target — then a trailing empty element.
 *
 * Captured commit OIDs (the per-fixture HEAD oid the producer would observe):
 *   sessionOnly            40cf7b0ab6801e681c2df9cd43d59815d67e2cb2
 *   jobIdOnly              7f9e0ee57c58c9d0754ea6cc7433a2cbc8c2a369
 *   sessionJobEqual        67a0bb9c8aa119c23f9263ab7fcfb285ba8373e4
 *   sessionJobDiffer       81127e4b16d94e14b9bbefdf6fdf62d12ca78ad7
 *   noTrailers             44f1e41b8d16935a25ace4c5a7e17cb0e5e4ac6f
 *   sessionOneTask         7e89bd8c1042f3cd1b40b994d307e353e79e3a6f
 *   sessionTwoTasks        4b9db821d490aa39692d5d09af94d6fa358dbeae
 *   allThree               df8b8529946d342e298b11c4e5ac4fc12a31eed2
 *   multiTrailerDelta      ae900bd0a26191d67412558491a71228b166bfeb (parent d03300a…)
 *   multiTrailerOid1Alone  d03300abe90fab27722c8c34432097c94790e16e
 *   planOpTarget           977718dd2b69077397a4133f1ffb62bfd6c3b170
 *   planTaskForm           ed3cc38206d4fcd65f6ac0999924176bd1ceb434
 *   noPlanctl              382f566ce34e0ba8e5d447e3f12a199c9433771d
 *   planMalformedTarget    f5d16cf14ed9594edd0893b1df3fe103bdf1190b
 *   allEight               0341f2603e15fc6f2391e7ff58d1bbd8892d4401
 *   multiPlanDelta         83c4cc87efa66139531c4c7a5b34d762e3ea17c3 (parent 9649583…)
 *   multiPlanOid1Alone     9649583eb76694663bd33daa54e59f3ccfc14b3a
 */
export const GIT_LOG_GOLDENS = {
  sessionOnly:
    "40cf7b0ab6801e681c2df9cd43d59815d67e2cb2\x00\x001782179230\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00\x00\x00\x00",
  jobIdOnly:
    "7f9e0ee57c58c9d0754ea6cc7433a2cbc8c2a369\x00\x001782179230\x00\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00\x00\x00",
  sessionJobEqual:
    "67a0bb9c8aa119c23f9263ab7fcfb285ba8373e4\x00\x001782179231\x0001234567-89ab-cdef-0123-456789abcdef\n\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00\x00\x00",
  sessionJobDiffer:
    "81127e4b16d94e14b9bbefdf6fdf62d12ca78ad7\x00\x001782179231\x0001234567-89ab-cdef-0123-456789abcdef\n\x00fedcba98-7654-3210-fedc-ba9876543210\n\x00\x00\x00\x00",
  noTrailers:
    "44f1e41b8d16935a25ace4c5a7e17cb0e5e4ac6f\x00\x001782179231\x00\x00\x00\x00\x00\x00",
  sessionOneTask:
    "7e89bd8c1042f3cd1b40b994d307e353e79e3a6f\x00\x001782179231\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00fn-670-deterministic-committing-session.1\n\x00\x00\x00",
  sessionTwoTasks:
    "4b9db821d490aa39692d5d09af94d6fa358dbeae\x00\x001782179231\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00fn-670-deterministic-committing-session.1\nfn-670-deterministic-committing-session.2\n\x00\x00\x00",
  allThree:
    "df8b8529946d342e298b11c4e5ac4fc12a31eed2\x00\x001782179231\x0001234567-89ab-cdef-0123-456789abcdef\n\x0001234567-89ab-cdef-0123-456789abcdef\n\x00fn-670-deterministic-committing-session.1\nfn-670-deterministic-committing-session.2\n\x00\x00\x00",
  multiTrailerDelta:
    "ae900bd0a26191d67412558491a71228b166bfeb\x00d03300abe90fab27722c8c34432097c94790e16e\x001782179232\x00fedcba98-7654-3210-fedc-ba9876543210\n\x00\x00fn-670-deterministic-committing-session.2\n\x00\x00\x00",
  multiTrailerOid1Alone:
    "d03300abe90fab27722c8c34432097c94790e16e\x00\x001782179232\x00\x0001234567-89ab-cdef-0123-456789abcdef\n\x00fn-670-deterministic-committing-session.1\n\x00\x00\x00",
  planOpTarget:
    "977718dd2b69077397a4133f1ffb62bfd6c3b170\x00\x001782179232\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00\x00epic-scaffold\n\x00fn-670-deterministic-committing-session\n\x00",
  planTaskForm:
    "ed3cc38206d4fcd65f6ac0999924176bd1ceb434\x00\x001782179232\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00\x00task-done\n\x00fn-670-deterministic-committing-session.1\n\x00",
  noPlanctl:
    "382f566ce34e0ba8e5d447e3f12a199c9433771d\x00\x001782179232\x0001234567-89ab-cdef-0123-456789abcdef\n\x00\x00fn-670-deterministic-committing-session.1\n\x00\x00\x00",
  planMalformedTarget:
    "f5d16cf14ed9594edd0893b1df3fe103bdf1190b\x00\x001782179233\x00\x00\x00\x00epic-close\n\x00not-a-plan-ref\n\x00",
  allEight:
    "0341f2603e15fc6f2391e7ff58d1bbd8892d4401\x00\x001782179233\x0001234567-89ab-cdef-0123-456789abcdef\n\x0001234567-89ab-cdef-0123-456789abcdef\n\x00fn-670-deterministic-committing-session.1\nfn-670-deterministic-committing-session.2\n\x00task-done\n\x00fn-670-deterministic-committing-session.1\n\x00",
  multiPlanDelta:
    "83c4cc87efa66139531c4c7a5b34d762e3ea17c3\x009649583eb76694663bd33daa54e59f3ccfc14b3a\x001782179233\x00fedcba98-7654-3210-fedc-ba9876543210\n\x00\x00\x00task-done\n\x00fn-670-deterministic-committing-session.2\n\x00",
  multiPlanOid1Alone:
    "9649583eb76694663bd33daa54e59f3ccfc14b3a\x00\x001782179233\x00\x00\x00\x00epic-scaffold\n\x00fn-670-deterministic-committing-session\n\x00",
} as const;

/** Captured `git diff-tree -r --no-commit-id --no-renames -z` byte strings. */
export const GIT_DIFF_TREE_GOLDENS = {
  /** A `git rm` of one plan json → one `D`-status record (blob_oid zero). */
  planDelete:
    ":100644 000000 2c45269123492035bcf58a18b87b3d03f661e4fb 0000000000000000000000000000000000000000 D\x00.keeper/epics/fn-1-x.json\x00",
  /** A scaffold burst: 3 plan json + 1 src `A`-status records. */
  planAdd:
    ":000000 100644 0000000000000000000000000000000000000000 16feda01261b3b358619b5d8ed6a8065c9406918 A\x00.keeper/epics/fn-1-x.json\x00:000000 100644 0000000000000000000000000000000000000000 5bc5b2bdf1ee9b8ad6aebe6b19be9476352fdcd8 A\x00.keeper/tasks/fn-1-x.1.json\x00:000000 100644 0000000000000000000000000000000000000000 c3fb6ef72c9a182de3d568bfedb3f38cadd1adb2 A\x00.keeper/tasks/fn-1-x.2.json\x00:000000 100644 0000000000000000000000000000000000000000 85de9cf93344b897ee6b677d44c645d747f82b0c A\x00src-a.ts\x00",
} as const;

/** Captured OIDs the multi-commit deltas key on (the synthetic assertions
 *  reference these instead of a runtime-generated oid). */
export const GOLDEN_OIDS = {
  multiTrailerOid1: "d03300abe90fab27722c8c34432097c94790e16e",
  multiTrailerOid2: "ae900bd0a26191d67412558491a71228b166bfeb",
  multiPlanOid1: "9649583eb76694663bd33daa54e59f3ccfc14b3a",
  multiPlanOid2: "83c4cc87efa66139531c4c7a5b34d762e3ea17c3",
} as const;
