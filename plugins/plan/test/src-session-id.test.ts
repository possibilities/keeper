import { describe, expect, test } from "bun:test";
import { resolvePlanSessionId } from "../src/session_id";

describe("resolvePlanSessionId", () => {
  test("prefers an explicit neutral override", () => {
    expect(
      resolvePlanSessionId({
        KEEPER_PLAN_SESSION_ID: "manual",
        CLAUDE_CODE_SESSION_ID: "claude",
        KEEPER_JOB_ID: "pi",
      }),
    ).toBe("manual");
  });

  test("preserves native Claude identity before Keeper job identity", () => {
    expect(
      resolvePlanSessionId({
        CLAUDE_CODE_SESSION_ID: "claude",
        KEEPER_JOB_ID: "pi",
      }),
    ).toBe("claude");
  });

  test("uses Keeper job identity for a tracked Pi session", () => {
    expect(resolvePlanSessionId({ KEEPER_JOB_ID: "pi-job" })).toBe("pi-job");
  });

  test("trims values and returns null when none are usable", () => {
    expect(
      resolvePlanSessionId({
        KEEPER_PLAN_SESSION_ID: "  ",
        CLAUDE_CODE_SESSION_ID: "",
        KEEPER_JOB_ID: undefined,
      }),
    ).toBeNull();
  });
});
