import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionIndexRow,
  findCodexSessionId,
} from "../src/agent/codex-session-index";

const SESSION_ID = "019eec30-d7eb-7142-9363-5c1535537ee6";

function codexHome(): string {
  return mkdtempSync(join(tmpdir(), "agentwrap-codex-index-"));
}

function sessionDir(home: string, date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const dir = join(home, "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRollout(
  home: string,
  id: string,
  cwd: string,
  startedAtMs: number,
): void {
  const dir = sessionDir(home, new Date(startedAtMs));
  const path = join(dir, `rollout-2026-06-21T17-58-04-${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: new Date(startedAtMs).toISOString(),
      type: "session_meta",
      payload: { id, cwd },
    })}\n`,
  );
}

describe("Codex session index helpers", () => {
  test("appendSessionIndexRow writes Codex-compatible JSONL", () => {
    const home = codexHome();
    appendSessionIndexRow(home, SESSION_ID, "synthetic name");

    const line = readFileSync(join(home, "session_index.jsonl"), "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      id: SESSION_ID,
      thread_name: "synthetic name",
    });
  });

  test("findCodexSessionId selects the rollout matching cwd", () => {
    const home = codexHome();
    const startedAtMs = Date.now();
    writeRollout(
      home,
      "019eec30-d7eb-7142-9363-5c1535537ee6",
      "/tmp/other",
      startedAtMs,
    );
    writeRollout(
      home,
      "019eec31-01f1-7163-afa1-7facaaf72122",
      "/fake-home/code/agentwrap",
      startedAtMs,
    );

    expect(
      findCodexSessionId({
        codexHome: home,
        threadName: "synthetic name",
        expectedCwd: "/fake-home/code/agentwrap",
        startedAtMs,
      }),
    ).toBe("019eec31-01f1-7163-afa1-7facaaf72122");
  });

  test("findCodexSessionId ignores older rollouts with fresh mtimes", () => {
    const home = codexHome();
    const startedAtMs = Date.now();
    writeRollout(
      home,
      SESSION_ID,
      "/fake-home/code/agentwrap",
      startedAtMs - 60_000,
    );

    expect(
      findCodexSessionId({
        codexHome: home,
        threadName: "synthetic name",
        expectedCwd: "/fake-home/code/agentwrap",
        startedAtMs,
      }),
    ).toBeNull();
  });
});
