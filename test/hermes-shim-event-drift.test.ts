/**
 * Enforces the DRIFT GUARD invariant between the hermes shim's dep-free
 * registered event list (`HERMES_SHIM_EVENTS`, src/hermes-shim-contract.ts)
 * and the hook's translation table (`HERMES_EVENT_MAP`,
 * plugins/keeper/plugin/hooks/hermes-events-shim.ts). Previously the two were
 * derived from the same object; now they are separate literals reconciled
 * only by matching comments, so this test is the structural guard that
 * replaces that lost guarantee.
 */

import { describe, expect, test } from "bun:test";
import { HERMES_EVENT_MAP } from "../plugins/keeper/plugin/hooks/hermes-events-shim";
import { HERMES_SHIM_EVENTS } from "../src/hermes-shim-contract";

describe("hermes shim event set drift guard", () => {
  test("HERMES_EVENT_MAP key set equals HERMES_SHIM_EVENTS", () => {
    const mapKeys = Object.keys(HERMES_EVENT_MAP).sort();
    const contractKeys = [...HERMES_SHIM_EVENTS].sort();
    expect(mapKeys).toEqual(contractKeys);
  });
});
