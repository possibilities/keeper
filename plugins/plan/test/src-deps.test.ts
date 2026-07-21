// Unit tests for src/deps.ts — detectCycles / findDependents. The cycle path is
// the load-bearing string the integrity-gate + add-dep verbs surface, so the shape is
// pinned against the Python deps.py contract.

import { describe, expect, test } from "bun:test";

import { type DepGraph, detectCycles, findDependents } from "../src/deps.ts";

describe("detectCycles", () => {
  test("acyclic graph -> null", () => {
    const g: DepGraph = {
      a: { depends_on: ["b"] },
      b: { depends_on: ["c"] },
      c: {},
    };
    expect(detectCycles(g)).toBeNull();
  });

  test("self-loop -> [node, node]", () => {
    const g: DepGraph = { a: { depends_on: ["a"] } };
    expect(detectCycles(g)).toEqual(["a", "a"]);
  });

  test("two-node cycle path matches the Python walk", () => {
    // a -> b -> a; DFS from a discovers the back-edge into the rec stack.
    const g: DepGraph = {
      a: { depends_on: ["b"] },
      b: { depends_on: ["a"] },
    };
    expect(detectCycles(g)).toEqual(["a", "b", "a"]);
  });

  test("longer cycle prepends each node on the recursive arm", () => {
    const g: DepGraph = {
      a: { depends_on: ["b"] },
      b: { depends_on: ["c"] },
      c: { depends_on: ["a"] },
    };
    expect(detectCycles(g)).toEqual(["a", "b", "c", "a"]);
  });

  test("node and adjacency insertion order do not change the cycle path", () => {
    const g: DepGraph = {
      c: { depends_on: ["a"] },
      b: { depends_on: ["a"] },
      a: { depends_on: ["c", "b"] },
    };
    expect(detectCycles(g)).toEqual(["a", "b", "a"]);
  });

  test("missing depends_on key is treated as no edges", () => {
    const g: DepGraph = { a: {}, b: {} };
    expect(detectCycles(g)).toBeNull();
  });
});

describe("findDependents", () => {
  test("direct + transitive dependents", () => {
    const all: DepGraph = {
      a: {},
      b: { depends_on: ["a"] },
      c: { depends_on: ["b"] },
      d: {},
    };
    expect([...findDependents("a", all)].sort()).toEqual(["b", "c"]);
  });

  test("no dependents -> empty", () => {
    const all: DepGraph = { a: {}, b: { depends_on: ["c"] } };
    expect(findDependents("a", all)).toEqual([]);
  });
});
