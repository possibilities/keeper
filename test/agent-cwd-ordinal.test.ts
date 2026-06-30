/**
 * cwd-ordinal counter: monotonic per-cwd-basename increment under a flock held
 * on the data file directly (non-truncating open via agentusage's raw flock
 * exports), with fail-open on a corrupt file. The default counter path resolves
 * under ~/.local/state/keeper-agent, so the basic suite runs against the real
 * state dir and cleans up the keys it touches (unique basenames keep them
 * isolated). The relocation suite overrides XDG_STATE_HOME onto a tmpdir so the
 * old→new dir rename is exercised hermetically, never touching real home state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateLegacyAgentStateDir,
  nextCwdOrdinal,
} from "../src/agent/cwd-ordinal";
import { defaultKeeperAgentStateDir } from "../src/agent/tmux-launch";

const counterPath = join(
  homedir(),
  ".local",
  "state",
  "keeper-agent",
  "cwd-ordinals.json",
);

const touchedKeys: string[] = [];

function uniqueKey(): string {
  const k = `keeper-agent-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  touchedKeys.push(k);
  return k;
}

afterEach(() => {
  // Remove only the keys this suite created — never clobber a real counter.
  if (!existsSync(counterPath)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(counterPath, "utf8")) as Record<
      string,
      unknown
    >;
    let changed = false;
    for (const k of touchedKeys) {
      if (k in data) {
        delete data[k];
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(counterPath, `${JSON.stringify(data, null, 2)}\n`);
    }
  } catch {
    // best-effort cleanup
  }
});

describe("nextCwdOrdinal", () => {
  test("first call returns 1, then increments monotonically", () => {
    const key = uniqueKey();
    expect(nextCwdOrdinal(key)).toBe(1);
    expect(nextCwdOrdinal(key)).toBe(2);
    expect(nextCwdOrdinal(key)).toBe(3);
  });

  test("distinct keys are independent", () => {
    const a = uniqueKey();
    const b = uniqueKey();
    expect(nextCwdOrdinal(a)).toBe(1);
    expect(nextCwdOrdinal(b)).toBe(1);
    expect(nextCwdOrdinal(a)).toBe(2);
  });

  test("existing content survives (non-truncating open)", () => {
    const a = uniqueKey();
    const b = uniqueKey();
    nextCwdOrdinal(a); // a = 1
    nextCwdOrdinal(b); // b = 1
    nextCwdOrdinal(a); // a = 2
    // b's counter must be intact despite a's rewrites.
    expect(nextCwdOrdinal(b)).toBe(2);
  });
});

/**
 * Relocation of the legacy `agentwrap` state dir to `keeper-agent`. XDG_STATE_HOME
 * points at a throwaway tmpdir so old (`<xdg>/agentwrap`) and new
 * (`<xdg>/keeper-agent`) live together off real home; process.env is restored and
 * the tmpdir removed in a finally. Bun's `--isolate` runs each file in its own
 * process, so the env override never leaks to a sibling file.
 */
describe("state-dir relocation", () => {
  function withXdgStateHome(fn: (xdg: string) => void): void {
    const prev = process.env.XDG_STATE_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "keeper-agent-statedir-"));
    process.env.XDG_STATE_HOME = xdg;
    try {
      fn(xdg);
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prev;
      }
      rmSync(xdg, { recursive: true, force: true });
    }
  }

  function writeCounter(dir: string, value: Record<string, number>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cwd-ordinals.json"),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  function readCounter(dir: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(dir, "cwd-ordinals.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  test("migrate renames old→new, the counter value surviving the relocation", () => {
    withXdgStateHome((xdg) => {
      const oldDir = join(xdg, "agentwrap");
      const newDir = join(xdg, "keeper-agent");
      writeCounter(oldDir, { repo: 7 });
      migrateLegacyAgentStateDir();
      expect(existsSync(oldDir)).toBe(false);
      expect(readCounter(newDir)).toEqual({ repo: 7 });
    });
  });

  test("nextCwdOrdinal transparently continues the migrated counter", () => {
    withXdgStateHome((xdg) => {
      writeCounter(join(xdg, "agentwrap"), { proj: 4 });
      // First call migrates old→new, then increments the surviving value.
      expect(nextCwdOrdinal("proj")).toBe(5);
      expect(existsSync(join(xdg, "agentwrap"))).toBe(false);
      expect(readCounter(join(xdg, "keeper-agent"))).toEqual({ proj: 5 });
    });
  });

  test("new dir already present → rename skipped, new wins, old not unlinked", () => {
    withXdgStateHome((xdg) => {
      const oldDir = join(xdg, "agentwrap");
      const newDir = join(xdg, "keeper-agent");
      writeCounter(oldDir, { a: 1 });
      writeCounter(newDir, { a: 99 });
      migrateLegacyAgentStateDir();
      // New is authoritative and untouched; the old lock file is left in place
      // (never unlink+recreated).
      expect(readCounter(newDir)).toEqual({ a: 99 });
      expect(existsSync(oldDir)).toBe(true);
    });
  });

  test("old dir absent → migrate is a no-op (fresh install, no throw)", () => {
    withXdgStateHome((xdg) => {
      expect(() => migrateLegacyAgentStateDir()).not.toThrow();
      expect(existsSync(join(xdg, "keeper-agent"))).toBe(false);
      expect(existsSync(join(xdg, "agentwrap"))).toBe(false);
    });
  });

  test("unified stateDir honors XDG_STATE_HOME across both call sites", () => {
    withXdgStateHome((xdg) => {
      const newDir = join(xdg, "keeper-agent");
      // The launcher resolver and the cwd-ordinal counter resolve the SAME dir.
      expect(defaultKeeperAgentStateDir(process.env)).toBe(newDir);
      expect(nextCwdOrdinal("xdg-key")).toBe(1);
      expect(readCounter(newDir)).toEqual({ "xdg-key": 1 });
    });
  });
});
