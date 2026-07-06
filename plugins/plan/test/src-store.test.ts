// Unit tests for src/store.ts — the state-store spine. Pins the contracts the
// read-only verbs lean on (loadJsonSafe silent-on-corrupt, loadRuntime
// read-never-creates) plus the two spine utilities the verbs never invoke but
// must carry to parity: nowIso's KEEPER_PLAN_NOW verbatim-or-reject contract with a
// 6-digit wall-clock field, and getActor's resolution precedence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetExec, setExec } from "../src/exec.ts";
import {
  getActor,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "../src/store.ts";

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "planctl-store-test-"));
  for (const k of ["KEEPER_PLAN_NOW", "KEEPER_PLAN_ACTOR", "USER"]) {
    savedEnv[k] = process.env[k];
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["KEEPER_PLAN_NOW", "KEEPER_PLAN_ACTOR", "USER"]) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

describe("loadJsonSafe", () => {
  test("parses a valid JSON file", () => {
    const p = join(root, "ok.json");
    writeFileSync(p, '{"a": 1}');
    expect(loadJsonSafe(p)).toEqual({ a: 1 });
  });

  test("returns null on a missing file (no throw)", () => {
    expect(loadJsonSafe(join(root, "nope.json"))).toBeNull();
  });

  test("returns null on a corrupt file (silent)", () => {
    const p = join(root, "bad.json");
    writeFileSync(p, "{not json");
    expect(loadJsonSafe(p)).toBeNull();
  });
});

describe("LocalFileStateStore.loadRuntime", () => {
  test("reads an existing overlay", () => {
    const stateDir = join(root, "state");
    mkdirSync(join(stateDir, "tasks"), { recursive: true });
    writeFileSync(
      join(stateDir, "tasks", "fn-1-x.1.state.json"),
      '{"status": "in_progress"}',
    );
    const store = new LocalFileStateStore(stateDir);
    expect(store.loadRuntime("fn-1-x.1")).toEqual({ status: "in_progress" });
  });

  test("absent overlay returns null and creates nothing (read-never-creates)", () => {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const store = new LocalFileStateStore(stateDir);
    expect(store.loadRuntime("fn-1-x.9")).toBeNull();
    // No tasks/ dir or sidecar materialized by the read.
    expect(existsSync(join(stateDir, "tasks"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

// CITED HERE (tests/test_now_iso_contract.py — every node maps to the nowIso
// units below; the boundary node maps to an end-to-end stamp pin elsewhere):
//   test_now_iso_contract.py::test_format_string_is_pinned -> the verbatim/6-digit
//     the accepted %Y-%m-%dT%H:%M:%S.%fZ shape (the format string itself is not
//     a bun export; its acceptance IS the contract under test).
//   test_now_iso_contract.py::test_set_and_valid_returns_verbatim -> "...returned verbatim"
//   test_now_iso_contract.py::test_malformed_is_hard_error -> the malformed / millisecond /
//     calendar-impossible rejection tests below (the 5 bad inputs collapse onto
//     these shape-class assertions).
//   test_now_iso_contract.py::test_unset_returns_wall_clock -> "wall-clock fallback ... 6-digit"
//   test_now_iso_contract.py::test_boundary_stamped_field_equals_frozen_value -> end-to-end stamp
//     equality (the sole arm stamps last_validated_at == frozen KEEPER_PLAN_NOW) is pinned
//     by verbs-query.test.ts "validate --epic stamps on the None transition"; a gate
//     verb's updated_at == FROZEN is pinned across verbs-restamp.test.ts.
describe("nowIso KEEPER_PLAN_NOW contract", () => {
  test("a well-formed override is returned verbatim (no round-trip)", () => {
    process.env.KEEPER_PLAN_NOW = "2026-06-12T08:44:14.300970Z";
    expect(nowIso()).toBe("2026-06-12T08:44:14.300970Z");
  });

  test("the microsecond field is preserved exactly (no Date truncation)", () => {
    process.env.KEEPER_PLAN_NOW = "2026-01-02T03:04:05.000001Z";
    expect(nowIso()).toBe("2026-01-02T03:04:05.000001Z");
  });

  test("a malformed override is a hard error, never a wall-clock fallback", () => {
    process.env.KEEPER_PLAN_NOW = "2026-06-12T08:44:14Z"; // 3-digit fraction missing
    expect(() => nowIso()).toThrow();
  });

  test("a millisecond-precision override is rejected (must be 6 digits)", () => {
    process.env.KEEPER_PLAN_NOW = "2026-06-12T08:44:14.300Z";
    expect(() => nowIso()).toThrow();
  });

  test("a calendar-impossible override is rejected", () => {
    process.env.KEEPER_PLAN_NOW = "2026-13-12T08:44:14.300000Z";
    expect(() => nowIso()).toThrow();
  });

  test("wall-clock fallback is shaped %Y-%m-%dT%H:%M:%S.%fZ with a 6-digit field", () => {
    delete process.env.KEEPER_PLAN_NOW;
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});

describe("getActor precedence", () => {
  // Drive the git-config probe through a faked exec so the precedence ladder
  // runs git-free. config(map) returns map[key] for `git config <key>`, null
  // (exit 1) for an unmapped key.
  function config(map: Record<string, string>): void {
    setExec({
      run(command, argv) {
        if (command === "git" && argv[0] === "config") {
          const key = argv[1] as string;
          const v = map[key];
          return v !== undefined
            ? { exitCode: 0, stdout: `${v}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 127, stdout: "", stderr: "no driver" };
      },
    });
  }
  afterEach(() => {
    resetExec();
  });

  test("KEEPER_PLAN_ACTOR wins and is trimmed", () => {
    process.env.KEEPER_PLAN_ACTOR = "  alice@example.com  ";
    expect(getActor()).toBe("alice@example.com");
  });

  test("git user.email is next when KEEPER_PLAN_ACTOR unset", () => {
    delete process.env.KEEPER_PLAN_ACTOR;
    config({ "user.email": "git-email@example.com", "user.name": "Git Name" });
    expect(getActor()).toBe("git-email@example.com");
  });

  test("falls to git user.name when email absent", () => {
    delete process.env.KEEPER_PLAN_ACTOR;
    config({ "user.name": "Git Name" });
    expect(getActor()).toBe("Git Name");
  });

  test("falls to USER, then 'unknown', when git config empty", () => {
    delete process.env.KEEPER_PLAN_ACTOR;
    config({});
    const savedUser = process.env.USER;
    process.env.USER = "shell-user";
    expect(getActor()).toBe("shell-user");
    delete process.env.USER;
    expect(getActor()).toBe("unknown");
    if (savedUser === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = savedUser;
    }
  });
});
