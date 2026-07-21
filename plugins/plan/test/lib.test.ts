// Unit tests for plugin/hooks/lib.ts — the shared dispatcher primitives.
//
// readMarker is exercised against a temp HOME so the on-disk marker contract
// (incl. 7-day stale-unlink and non-object rejection) matches the Python
// session_markers.py read side byte-for-byte. Envelope emitters are captured
// off a real subprocess so the assertion covers the true stdout discipline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isBypassed, readMarker, SCHEMA_VERSION } from "../plugin/hooks/lib.ts";

const SESSION = "sess-abc";
let home: string;
let sessionsDir: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-plan-lib-test-"));
  origHome = process.env.HOME;
  process.env.HOME = home;
  sessionsDir = join(home, ".local", "state", "keeper", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeMarker(sessionId: string, record: unknown): string {
  const path = join(sessionsDir, `${sessionId}.json`);
  writeFileSync(path, JSON.stringify(record), "utf-8");
  return path;
}

describe("readMarker", () => {
  test("returns null for an absent marker", async () => {
    expect(await readMarker(SESSION)).toBeNull();
  });

  test("returns null for an empty session id", async () => {
    expect(await readMarker("")).toBeNull();
  });

  test("reads a fresh work marker honoring the schema-2 fields", async () => {
    writeMarker(SESSION, {
      schema_version: SCHEMA_VERSION,
      session_id: SESSION,
      kind: "work",
      task_id: "fn-1-x.2",
      created_at: "2026-06-11T00:00:00Z",
      pid: 4242,
      start_time: "test:process-start",
    });
    const marker = await readMarker(SESSION);
    expect(marker).not.toBeNull();
    expect(marker?.kind).toBe("work");
    expect(marker?.task_id).toBe("fn-1-x.2");
    expect(marker?.schema_version).toBe(2);
    expect(marker?.pid).toBe(4242);
    expect(marker?.start_time).toBe("test:process-start");
  });

  test("reads a close marker carrying epic_id", async () => {
    writeMarker(SESSION, {
      schema_version: SCHEMA_VERSION,
      session_id: SESSION,
      kind: "close",
      epic_id: "fn-1-x",
      created_at: "2026-06-11T00:00:00Z",
    });
    const marker = await readMarker(SESSION);
    expect(marker?.kind).toBe("close");
    expect(marker?.epic_id).toBe("fn-1-x");
  });

  test("unlinks and returns null for a marker older than 7 days", async () => {
    const path = writeMarker(SESSION, {
      schema_version: SCHEMA_VERSION,
      session_id: SESSION,
      kind: "work",
      task_id: "fn-1-x.2",
      created_at: "2020-01-01T00:00:00Z",
    });
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(path, eightDaysAgo, eightDaysAgo);

    expect(await readMarker(SESSION)).toBeNull();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("unlinks and returns null for a non-object marker", async () => {
    const path = join(sessionsDir, `${SESSION}.json`);
    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf-8");
    expect(await readMarker(SESSION)).toBeNull();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("returns null for unparseable JSON without throwing", async () => {
    const path = join(sessionsDir, `${SESSION}.json`);
    writeFileSync(path, "{not json", "utf-8");
    expect(await readMarker(SESSION)).toBeNull();
  });
});

describe("isBypassed", () => {
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env.KEEPER_PLAN_GUARD_BYPASS;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.KEEPER_PLAN_GUARD_BYPASS;
    else process.env.KEEPER_PLAN_GUARD_BYPASS = orig;
  });

  test("true only for exactly '1'", () => {
    process.env.KEEPER_PLAN_GUARD_BYPASS = "1";
    expect(isBypassed()).toBe(true);
  });

  test("false when unset", () => {
    delete process.env.KEEPER_PLAN_GUARD_BYPASS;
    expect(isBypassed()).toBe(false);
  });

  test("false for other truthy-looking values", () => {
    process.env.KEEPER_PLAN_GUARD_BYPASS = "true";
    expect(isBypassed()).toBe(false);
  });
});

// Emitters are exercised through a real subprocess so the assertion covers the
// true stdout discipline (exactly one JSON line, nothing else) rather than a
// stubbed write — process.stdout.write is a native binding the in-process spy
// does not reliably intercept under Bun.
const LIB = join(import.meta.dir, "..", "plugin", "hooks", "lib.ts");

async function captureEmit(call: string): Promise<string> {
  const proc = Bun.spawn(
    ["bun", "-e", `import { emitDeny, emitBlock } from "${LIB}"; ${call}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe("envelope emitters", () => {
  test("emitDeny writes exactly one PreToolUse deny envelope", async () => {
    const out = await captureEmit('emitDeny("no commits in main context");');
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toBe(
      "no commits in main context",
    );
    expect(payload.decision).toBeUndefined();
  });

  test("emitBlock writes exactly one top-level block decision", async () => {
    const out = await captureEmit('emitBlock("resume the task");');
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload.decision).toBe("block");
    expect(payload.reason).toBe("resume the task");
  });
});
