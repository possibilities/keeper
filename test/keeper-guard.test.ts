import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTBUS_EXEC_SESSION,
  MANAGED_EXEC_SESSION,
  PAIR_EXEC_SESSION,
  PANELS_EXEC_SESSION,
  WRAPPED_EXEC_SESSION,
} from "../src/exec-backend";

// Fast, in-process content guard for the static tmux drop-in. No tmux is
// spawned here — the real-tmux behavior lives in `keeper-guard.slow.test.ts`.
// This pins the duplicated-by-value literals to their TS source of truth so a
// rename in `exec-backend.ts` trips the test instead of silently drifting.

const CONF = readFileSync(
  join(import.meta.dir, "..", "tmux", "keeper-guard.conf"),
  "utf8",
);

describe("keeper-guard.conf content", () => {
  test("includes all 5 managed sessions in the future hook and load-time sweep", () => {
    const managedSessions = [
      MANAGED_EXEC_SESSION,
      PAIR_EXEC_SESSION,
      PANELS_EXEC_SESSION,
      AGENTBUS_EXEC_SESSION,
      WRAPPED_EXEC_SESSION,
    ];
    for (const name of managedSessions) {
      expect(CONF).toContain(`#{==:#{session_name},${name}}`);
    }
    expect(/for s in ([^;]+);/.exec(CONF)?.[1]?.split(" ")).toEqual(
      managedSessions,
    );
  });

  test("stamps the session-scoped marker @keeper_managed_session", () => {
    expect(CONF).toContain("@keeper_managed_session");
    expect(CONF).toContain("set-option @keeper_managed_session 1");
  });

  test("uses the indexed session-created[42] hook form", () => {
    expect(CONF).toContain("set-hook -g 'session-created[42]'");
    // NOT the clobbering `-g` replace nor the duplicating `-ga` append.
    expect(CONF).not.toContain("set-hook -ga 'session-created'");
    expect(CONF).not.toMatch(/set-hook -g 'session-created'[^[]/);
  });

  test("has a non-blocking -b load-time sweep", () => {
    expect(CONF).toContain("run-shell -b");
  });

  test('guards create-keys c / | / _ and root M-\\ / M-- but not % or "', () => {
    expect(CONF).toContain("bind-key c if-shell");
    expect(CONF).toContain("bind-key | if-shell");
    expect(CONF).toContain("bind-key _ if-shell");
    expect(CONF).toContain("bind-key -n M-'\\' if-shell");
    expect(CONF).toContain("bind-key -n M-'-' if-shell");
    // `%` and `"` are unbound by the human's splitting.conf — out of scope.
    expect(CONF).not.toContain("bind-key %");
    expect(CONF).not.toContain('bind-key "');
  });

  test("every guarded bind gates on the marker via if-shell -F", () => {
    const guardLines = CONF.split("\n").filter((l) => l.startsWith("bind-key"));
    expect(guardLines).toHaveLength(5);
    for (const line of guardLines) {
      expect(line).toContain("if-shell -F '#{@keeper_managed_session}'");
    }
  });
});
