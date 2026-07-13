/**
 * Birth-record contract + launcher wiring pins (fn-1103).
 *
 * Two halves: the pure `src/birth-record.ts` leaf (serialize/parse round-trip,
 * torn-record rejection, maildir atomic write, start_time parsers, env-derived
 * coords/worktree/draft), and the `main()` launcher wiring — every Pi launch
 * emits exactly one draft with the right identity + env exports, claude emits
 * none, a resume reuses the original job id, and the detached OUTER wrapper
 * emits nothing (the inner re-exec owns the write). No live harness / ps fork:
 * the launcher's `emitBirthRecord` seam records in memory, the probe is tested
 * via its pure parsers.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import {
  BIRTH_RECORD_SCHEMA_VERSION,
  type BirthRecord,
  birthBackendCoordsFromEnv,
  birthWorktreeFromEnv,
  buildBirthDraft,
  darwinLstartToStartTime,
  linuxStatToStartTime,
  parseBirthRecord,
  resolveBirthDir,
  serializeBirthRecord,
  writeBirthRecord,
} from "../src/birth-record";
import {
  DARWIN_LSTART_CASES,
  LINUX_STAT_CASES,
} from "./fixtures/start-time-parser-cases";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "keeper-birth-test-"));
}

const FULL: BirthRecord = {
  schema_version: BIRTH_RECORD_SCHEMA_VERSION,
  session_id: "job-123",
  harness: "pi",
  pid: 4242,
  start_time: "darwin:Wed Jul  3 12:00:00 2026",
  cwd: "/home/u/proj",
  spawn_name: "proj-001",
  config_dir: "/home/u/.pi",
  backend_exec_type: "tmux",
  backend_exec_session_id: "pair",
  backend_exec_pane_id: "%8",
  worktree: "keeper/epic/fn-1",
  launch_ts: "2026-07-03T12:00:00.000Z",
  resume_target: null,
  dispatch_attempt_id: null,
};

describe("serialize / parse round-trip", () => {
  test("round-trips a full record byte-for-byte", () => {
    const line = serializeBirthRecord(FULL);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseBirthRecord(line)).toEqual(FULL);
  });

  test("round-trips with all nullable fields null", () => {
    const sparse: BirthRecord = {
      ...FULL,
      start_time: null,
      spawn_name: null,
      config_dir: null,
      backend_exec_type: null,
      backend_exec_session_id: null,
      backend_exec_pane_id: null,
      worktree: null,
      resume_target: "resume-abc",
    };
    expect(parseBirthRecord(serializeBirthRecord(sparse))).toEqual(sparse);
  });

  test("the trailing newline is optional on parse input", () => {
    const line = serializeBirthRecord(FULL).replace(/\n$/, "");
    expect(parseBirthRecord(line)).toEqual(FULL);
  });
});

describe("parse rejects torn / malformed records", () => {
  test("a truncated (torn) tail parses to null, never a half record", () => {
    const json = JSON.stringify(FULL);
    // Every prefix short of the whole JSON body (incl. dropping the closing `}`)
    // is unparseable → null; the offset must never advance past a torn line.
    for (const cut of [10, Math.floor(json.length / 2), json.length - 1]) {
      expect(parseBirthRecord(json.slice(0, cut))).toBeNull();
    }
  });

  test("empty / whitespace-only → null", () => {
    expect(parseBirthRecord("")).toBeNull();
    expect(parseBirthRecord("   \n")).toBeNull();
  });

  test("a non-object / array body → null", () => {
    expect(parseBirthRecord("42")).toBeNull();
    expect(parseBirthRecord('"a string"')).toBeNull();
    expect(parseBirthRecord("[1,2,3]")).toBeNull();
    expect(parseBirthRecord("null")).toBeNull();
  });

  test("a missing or wrong-typed required field → null", () => {
    const drop = (k: keyof BirthRecord) => {
      const o: Record<string, unknown> = { ...FULL };
      delete o[k];
      return `${JSON.stringify(o)}`;
    };
    expect(parseBirthRecord(drop("session_id"))).toBeNull();
    expect(parseBirthRecord(drop("pid"))).toBeNull();
    expect(parseBirthRecord(drop("cwd"))).toBeNull();
    // Wrong types.
    expect(
      parseBirthRecord(JSON.stringify({ ...FULL, pid: "4242" })),
    ).toBeNull();
    expect(
      parseBirthRecord(JSON.stringify({ ...FULL, session_id: "" })),
    ).toBeNull();
    expect(
      parseBirthRecord(JSON.stringify({ ...FULL, spawn_name: 7 })),
    ).toBeNull();
  });

  test("unsupported harnesses and schema versions parse to null", () => {
    for (const harness of ["claude", "hermes", "codex", "other"]) {
      expect(parseBirthRecord(JSON.stringify({ ...FULL, harness }))).toBeNull();
    }
    expect(
      parseBirthRecord(
        JSON.stringify({
          ...FULL,
          schema_version: BIRTH_RECORD_SCHEMA_VERSION + 1,
        }),
      ),
    ).toBeNull();
  });
});

describe("writeBirthRecord — maildir atomic write", () => {
  test("lands exactly one parseable file in new/, none left in tmp/", () => {
    const dir = tempDir();
    try {
      writeBirthRecord(dir, FULL);
      const tmpFiles = readdirSync(join(dir, "tmp"));
      const newFiles = readdirSync(join(dir, "new"));
      expect(tmpFiles).toEqual([]);
      expect(newFiles).toHaveLength(1);
      const body = readFileSync(
        join(dir, "new", newFiles[0] as string),
        "utf8",
      );
      expect(parseBirthRecord(body)).toEqual(FULL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent on (pid, start_time) — a re-announce overwrites", () => {
    const dir = tempDir();
    try {
      writeBirthRecord(dir, FULL);
      writeBirthRecord(dir, { ...FULL, spawn_name: "re-announced" });
      const newFiles = readdirSync(join(dir, "new"));
      expect(newFiles).toHaveLength(1);
      const body = readFileSync(
        join(dir, "new", newFiles[0] as string),
        "utf8",
      );
      expect(parseBirthRecord(body)?.spawn_name).toBe("re-announced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distinct (pid, start_time) records land in distinct files", () => {
    const dir = tempDir();
    try {
      writeBirthRecord(dir, FULL);
      writeBirthRecord(dir, { ...FULL, pid: 9001 });
      expect(readdirSync(join(dir, "new"))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveBirthDir", () => {
  test("KEEPER_BIRTH_DIR override wins", () => {
    expect(resolveBirthDir({ KEEPER_BIRTH_DIR: "/x/births" })).toBe(
      "/x/births",
    );
  });
  test("falls back to ~/.local/state/keeper/births", () => {
    const p = resolveBirthDir({});
    expect(p.endsWith(join(".local", "state", "keeper", "births"))).toBe(true);
  });
  test("empty / whitespace override falls back", () => {
    expect(resolveBirthDir({ KEEPER_BIRTH_DIR: "  " }).endsWith("births")).toBe(
      true,
    );
  });
});

describe("start_time parsers (pure — no ps fork)", () => {
  test("darwin lstart is platform-tagged and null on a bad shape", () => {
    for (const { input, expected } of DARWIN_LSTART_CASES) {
      expect(darwinLstartToStartTime(input)).toBe(expected);
    }
  });

  test("linux /proc stat field 22 is platform-tagged, comm-safe", () => {
    for (const { input, expected } of LINUX_STAT_CASES) {
      expect(linuxStatToStartTime(input)).toBe(expected);
    }
  });
});

describe("env-derived coords / worktree / draft", () => {
  test("native tmux env stamps type + pane + carrier session", () => {
    expect(
      birthBackendCoordsFromEnv({
        TMUX: "/tmp/tmux-x/default,1,0",
        TMUX_PANE: "%8",
        KEEPER_TMUX_SESSION: "pair",
      }),
    ).toEqual({ type: "tmux", sessionId: "pair", paneId: "%8" });
  });

  test("foreign tmux sockets stamp no coords", () => {
    expect(
      birthBackendCoordsFromEnv({
        TMUX: "/tmp/tmux-x/jobsearch,1,0",
        TMUX_PANE: "%8",
        KEEPER_TMUX_SESSION: "work",
      }),
    ).toEqual({ type: null, sessionId: null, paneId: null });
  });

  test("stripped tmux but carrier pane present stamps from the carrier", () => {
    expect(birthBackendCoordsFromEnv({ KEEPER_TMUX_PANE: "%9" })).toEqual({
      type: "tmux",
      sessionId: null,
      paneId: "%9",
    });
  });

  test("no tmux + no carrier is all-null (never a fabricated type)", () => {
    expect(birthBackendCoordsFromEnv({})).toEqual({
      type: null,
      sessionId: null,
      paneId: null,
    });
  });

  test("a capable adapter carries only a bounded exact Dispatch attempt", () => {
    const common = {
      session_id: "j",
      cwd: "/c",
      spawn_name: "work::fn-1.1",
      config_dir: null,
      resume_target: "j",
      launch_ts: "2026-07-03T00:00:00.000Z",
    };
    expect(
      buildBirthDraft(
        { KEEPER_DISPATCH_ATTEMPT_ID: "42" },
        { ...common, harness: "pi" },
      ).dispatch_attempt_id,
    ).toBe(42);
    expect(
      buildBirthDraft(
        { KEEPER_DISPATCH_ATTEMPT_ID: "not-an-attempt" },
        { ...common, harness: "pi" },
      ).dispatch_attempt_id,
    ).toBeNull();
  });

  test("worktree reads KEEPER_PLAN_WORKTREE_BRANCH; empty → null", () => {
    expect(
      birthWorktreeFromEnv({ KEEPER_PLAN_WORKTREE_BRANCH: "keeper/epic/x" }),
    ).toBe("keeper/epic/x");
    expect(
      birthWorktreeFromEnv({ KEEPER_PLAN_WORKTREE_BRANCH: "  " }),
    ).toBeNull();
    expect(birthWorktreeFromEnv({})).toBeNull();
  });

  test("buildBirthDraft assembles coords + worktree + schema", () => {
    const draft = buildBirthDraft(
      {
        TMUX: "/tmp/tmux-x/default,1,0",
        TMUX_PANE: "%1",
        KEEPER_PLAN_WORKTREE_BRANCH: "wt",
      },
      {
        session_id: "j",
        harness: "pi",
        cwd: "/c",
        spawn_name: "n",
        config_dir: "/cfg",
        resume_target: "j",
        launch_ts: "2026-07-03T00:00:00.000Z",
      },
    );
    expect(draft).toEqual({
      schema_version: BIRTH_RECORD_SCHEMA_VERSION,
      session_id: "j",
      harness: "pi",
      cwd: "/c",
      spawn_name: "n",
      config_dir: "/cfg",
      backend_exec_type: "tmux",
      backend_exec_session_id: null,
      backend_exec_pane_id: "%1",
      worktree: "wt",
      launch_ts: "2026-07-03T00:00:00.000Z",
      resume_target: "j",
      dispatch_attempt_id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// main() launcher wiring
// ---------------------------------------------------------------------------

const UUID = "00000000-0000-0000-0000-000000000000";

function harness(agent: "claude" | "pi" | "hermes", argv: string[]) {
  return makeHarness({
    argv: [agent, ...argv],
    rawArgv: true,
    env: {},
  });
}

describe("main() emits birth records for Pi launches", () => {
  test("pi interactive → one record, pinned session id = job id = resume target", async () => {
    const h = harness("pi", ["--x-no-confirm", "hi"]);
    await runAndCapture(h, main);
    expect(h.birthRecords).toHaveLength(1);
    const { draft } = h.birthRecords[0] as (typeof h.birthRecords)[number];
    expect(draft.harness).toBe("pi");
    expect(draft.session_id).toBe(UUID);
    expect(draft.resume_target).toBe(UUID);
    expect(h.deps.env.KEEPER_JOB_ID).toBe(UUID);
    expect(h.deps.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
  });

  test("hermes interactive emits no birth record", async () => {
    const h = harness("hermes", ["--x-no-confirm", "-z", "hi"]);
    await runAndCapture(h, main);
    expect(h.birthRecords).toEqual([]);
  });

  test("claude launch emits NO birth record and sets no job-id env", async () => {
    const h = harness("claude", ["--x-no-confirm", "hi"]);
    await runAndCapture(h, main);
    expect(h.birthRecords).toEqual([]);
    expect(h.deps.env.KEEPER_JOB_ID).toBeUndefined();
  });

  test("a pi resume folds onto the carried job id AND stamps resume_target from the --session argv (identity ≠ resume key)", async () => {
    // The incident exemplar: keeper job `45f94c4d…` runs pi session `d98a2d54…`.
    // On resume the transport carries the ORIGINAL job id back in KEEPER_JOB_ID and
    // the harness-native `--session <native>` in the argv. The record must fold
    // onto the carried job id (no orphan) yet re-emit the NATIVE session as its
    // resume key — never the job id.
    const h = makeHarness({
      argv: ["pi", "--session", "d98a2d54-native"],
      rawArgv: true,
      env: { KEEPER_JOB_ID: "45f94c4d-orig" },
    });
    await runAndCapture(h, main);
    expect(h.birthRecords).toHaveLength(1);
    const { draft } = h.birthRecords[0] as (typeof h.birthRecords)[number];
    expect(draft.harness).toBe("pi");
    // Identity: folds onto the carried job id, no orphan minted.
    expect(draft.session_id).toBe("45f94c4d-orig");
    expect(h.deps.env.KEEPER_JOB_ID).toBe("45f94c4d-orig");
    // Resume key: the harness-native target from the argv, NOT the job id.
    expect(draft.resume_target).toBe("d98a2d54-native");
  });
});
