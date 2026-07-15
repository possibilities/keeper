import { describe, expect, test } from "bun:test";
import {
  invocationDescendsFrom,
  type ProcessIdentityReader,
  parseDarwinProcessIdentity,
  parseLinuxProcessIdentity,
} from "../src/commit-work/process-identity";

describe("commit-work invocation process identity", () => {
  test("parses Linux ppid and recycle-safe start time around a hostile comm", () => {
    const fields = [
      "S",
      "42",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "777",
    ];
    expect(
      parseLinuxProcessIdentity(`123 (odd ) process) ${fields.join(" ")}\n`),
    ).toEqual({ ppid: 42, startTime: "linux:777" });
    expect(parseLinuxProcessIdentity("malformed")).toBeNull();
  });

  test("parses only the fixed Darwin ps identity row", () => {
    expect(
      parseDarwinProcessIdentity("  42 Tue Jul 14 23:40:31 2026    \n"),
    ).toEqual({
      ppid: 42,
      startTime: "darwin:Tue Jul 14 23:40:31 2026",
    });
    expect(parseDarwinProcessIdentity("42 garbage\n")).toBeNull();
  });

  test("accepts only an exact ancestor pid and start-time pair", async () => {
    const rows = new Map([
      [9000, { ppid: 8000, startTime: "linux:900" }],
      [8000, { ppid: 4242, startTime: "linux:800" }],
      [4242, { ppid: 1, startTime: "linux:100" }],
      [5252, { ppid: 1, startTime: "linux:200" }],
    ]);
    const read: ProcessIdentityReader = (pid) => rows.get(pid) ?? null;

    expect(
      await invocationDescendsFrom(4242, "linux:100", {
        currentPid: 9000,
        read,
      }),
    ).toBe(true);
    expect(
      await invocationDescendsFrom(4242, "linux:wrong", {
        currentPid: 9000,
        read,
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(5252, "linux:200", {
        currentPid: 9000,
        read,
      }),
    ).toBe(false);
  });

  test("probe failures, cycles, and depth exhaustion fail closed", async () => {
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        read: () => null,
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        read: (pid) => ({ ppid: pid === 100 ? 99 : 100, startTime: "x" }),
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        maxDepth: 1,
        read: () => ({ ppid: 42, startTime: "x" }),
      }),
    ).toBe(false);
  });
});
