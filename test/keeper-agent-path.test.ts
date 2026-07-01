/**
 * Unit tests for the db.ts-free keeper-agent launcher path resolver
 * (`resolveKeeperAgentPathDepFree`): the `KEEPER_AGENT_PATH` env override wins and
 * is tilde-expanded at resolve time; otherwise the derived `cli/keeper.ts` default.
 */

import { expect, test } from "bun:test";
import { resolveKeeperAgentPathDepFree } from "../src/keeper-agent-path";

test("resolveKeeperAgentPathDepFree: KEEPER_AGENT_PATH wins; tilde expands; else derived default", () => {
  // The env override wins.
  expect(
    resolveKeeperAgentPathDepFree(
      { KEEPER_AGENT_PATH: "/custom/keeper.ts" },
      "/home/u",
    ),
  ).toBe("/custom/keeper.ts");
  // A leading ~/ in the override expands at resolve time.
  expect(
    resolveKeeperAgentPathDepFree(
      { KEEPER_AGENT_PATH: "~/bin/keeper.ts" },
      "/home/u",
    ),
  ).toBe("/home/u/bin/keeper.ts");
  // No override → derived `cli/keeper.ts` default (absolute, ends in keeper.ts).
  const derived = resolveKeeperAgentPathDepFree({}, "/home/u");
  expect(derived.startsWith("/")).toBe(true);
  expect(derived.endsWith("/cli/keeper.ts")).toBe(true);
});
