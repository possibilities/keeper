// Unit tests for src/ids.ts — parseId. The unparseable-sorts-as-999 behavior is
// the load-bearing contract for the epics verb's ordering.

import { describe, expect, test } from "bun:test";

import { parseId } from "../src/ids.ts";

describe("parseId", () => {
  test("epic id -> [num, null]", () => {
    expect(parseId("fn-1-cafe")).toEqual([1, null]);
  });

  test("task id -> [epic, task]", () => {
    expect(parseId("fn-12-add-queue.3")).toEqual([12, 3]);
  });

  test("bare fn-N (no slug) parses", () => {
    expect(parseId("fn-7")).toEqual([7, null]);
  });

  test("unparseable id -> [null, null] (sorts as 999 in epics)", () => {
    expect(parseId("fn-zzz-weird")).toEqual([null, null]);
    expect(parseId("garbage")).toEqual([null, null]);
  });
});
