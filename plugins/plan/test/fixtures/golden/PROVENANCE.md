# Read-surface golden corpus

Frozen reference output for the `list --format human` tree render and the
whole-project `validate` error catalog, consumed by
`test/verbs-query.test.ts`. Both fixtures are path-free by construction — only
ids / titles / statuses / error strings, no absolute tmp path — so the captured
bytes are machine-independent and pin byte-for-byte across engines.

These goldens ARE the spec: there is no live regeneration path in the test run.
A change to either render is a deliberate, reviewed edit to the captured bytes,
re-captured by the recipe below.

## Files

| file | sha256 | capture date |
|------|--------|--------------|
| `list_human.txt` | `ddcaadfbe0b46c978dfe3c7593b193bd7297065e9cf7e470b4c1c6aac612c824` | 2026-06-12 |
| `integrity_errors.txt` | `f18a9805f804c3d0b3769aa52076b7e9f54ef318b1f7ee2888e6442413fdf93a` | 2026-06-12 |

## Regeneration recipe

Seed the matching corpus, then capture under a frozen clock with color/locale
pinned (the renders are path-free, so the captured bytes are stable):

    PLANCTL_ACTOR=test@example.com PLANCTL_NOW=2026-06-06T00:00:00.000000Z \
    LC_ALL=C NO_COLOR=1 <binary> ...

* `list_human.txt` — `_seedListCorpus`: fn-1-cafe "Café résumé ☕" (3 tasks:
  todo / in_progress / done), fn-2-zeta "Zeta" (2 tasks: in_progress / todo).
  Run `<binary> --format human list` and drop the trailing
  `plan_invocation` line.
* `integrity_errors.txt` — `_seedInvalidCorpus`: fn-1-cafe with a ghost
  epic-dep (fn-99-ghost), a task dep to a missing .9, and a .1<->.2 cycle. Run
  `<binary> validate` and take the `errors` array, one error per line.
