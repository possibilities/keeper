/**
 * Shared source of truth for the platform-tagged start_time parsers'
 * expected behavior. `src/birth-record.ts`'s `darwinLstartToStartTime` /
 * `linuxStatToStartTime` and the hermes events shim's DRIFT-GUARD
 * byte-identical copies (`plugins/keeper/plugin/hooks/hermes-events-shim.ts`)
 * both consume these cases, so a silent drift between the two
 * implementations fails in both suites instead of two independently
 * maintained expectation sets going stale in isolation.
 */

export const DARWIN_LSTART_CASES: ReadonlyArray<{
  readonly input: string;
  readonly expected: string | null;
}> = [
  {
    input: "Wed Jul  3 12:00:00 2026  ps args",
    expected: "darwin:Wed Jul  3 12:00:00 2026",
  },
  { input: "not an lstart line", expected: null },
  { input: "", expected: null },
];

export const LINUX_STAT_CASES: ReadonlyArray<{
  readonly input: string;
  readonly expected: string | null;
}> = [
  // comm holds spaces + parens; the reader brackets on the LAST ')'.
  {
    input:
      "4242 (my ) proc) S 1 4242 4242 0 -1 0 1 1 1 1 1 1 1 1 20 0 1 0 998877 0 0",
    expected: "linux:998877",
  },
  { input: "no close paren", expected: null },
];
