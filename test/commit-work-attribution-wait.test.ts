/**
 * Read-side attribution wait tests (fn-921.4) — the bounded, fail-open wait that
 * lets `commit-work` ride the `.1` poll-only git producer's ~300ms scan cadence
 * so a file edited immediately before a commit is attributed + staged.
 *
 * Pure in-process: a `freshDbFile()` clone holds synthetic `events` mutation
 * rows + `file_attributions` rows, the live `git status` read is INJECTED
 * (`liveDirtyPaths`), and the wait's clock/sleep are INJECTED — so no real git,
 * no daemon, no real timers. Per CLAUDE.md isolation the DB lives under a
 * per-test tmpdir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSessionAttributionCaughtUp,
  pendingAttributionFiles,
  waitForAttributionCaughtUp,
} from "../src/commit-work/attribution";
import { openDb } from "../src/db";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
const REPO = "/repo";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-attr-wait-"));
  dbPath = join(tmpDir, "keeper.db");
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a PostToolUse mutation event (charges via the GitSnapshot fold later). */
function seedMutationEvent(opts: {
  sessionId: string;
  absPath: string;
  ts?: number;
  toolName?: string;
}): void {
  const { db } = openDb(dbPath, { migrate: false });
  db.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, mutation_path, data) " +
      "VALUES (?, ?, 'PostToolUse', 'PostToolUse', ?, ?, '{}')",
    [opts.ts ?? 100, opts.sessionId, opts.toolName ?? "Edit", opts.absPath],
  );
  db.close();
}

/** Seed a charged (undischarged) file_attributions row for the cwd repo. */
function seedAttribution(opts: {
  sessionId: string;
  filePath: string;
  projectDir?: string;
  lastCommitAt?: number | null;
}): void {
  const { db } = openDb(dbPath, { migrate: false });
  db.run(
    "INSERT INTO file_attributions " +
      "(project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source) " +
      "VALUES (?, ?, ?, ?, ?, 'edit', 'tool')",
    [
      opts.projectDir ?? REPO,
      opts.sessionId,
      opts.filePath,
      100,
      opts.lastCommitAt ?? null,
    ],
  );
  db.close();
}

/** A live `git status` injector returning a fixed repo-relative dirty set. */
function liveDirty(paths: string[]): () => Set<string> {
  return () => new Set(paths);
}

describe("pendingAttributionFiles", () => {
  test("a live-dirty session edit with no charged row is pending", () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    const pending = pendingAttributionFiles("s1", REPO, {
      dbPath,
      liveDirtyPaths: liveDirty(["src/a.ts"]),
    });
    expect(pending).toEqual(["src/a.ts"]);
  });

  test("a live-dirty session edit WITH a charged row is caught up", () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    seedAttribution({ sessionId: "s1", filePath: "src/a.ts" });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toEqual([]);
    expect(
      isSessionAttributionCaughtUp("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toBe(true);
  });

  test("an edited-then-reverted file (not live-dirty) never blocks", () => {
    // Mutation event exists but the file is no longer in the live dirty set —
    // must NOT be reported pending (the false-wait-forever guard).
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/gone.ts` });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty([]),
      }),
    ).toEqual([]);
  });

  test("an excluded .keeper/ mutation never blocks even when live-dirty", () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/.keeper/x.json` });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty([".keeper/x.json"]),
      }),
    ).toEqual([]);
  });

  test("a mutation outside the cwd repo is ignored", () => {
    seedMutationEvent({ sessionId: "s1", absPath: "/other/repo/b.ts" });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["b.ts"]),
      }),
    ).toEqual([]);
  });

  test("another session's edits don't make THIS session pending", () => {
    seedMutationEvent({ sessionId: "other", absPath: `${REPO}/src/a.ts` });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toEqual([]);
  });

  test("no session edits → caught up", () => {
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toEqual([]);
  });

  test("unreadable git (null dirty set) fails open — nothing pending", () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: () => null,
      }),
    ).toEqual([]);
  });

  test("a discharged attribution row does NOT count as charged", () => {
    // last_commit_at > last_mutation_at ⇒ discharged ⇒ not an undischarged claim,
    // so the live-dirty edit is still pending until a fresh charge lands.
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    seedAttribution({
      sessionId: "s1",
      filePath: "src/a.ts",
      lastCommitAt: 200,
    });
    expect(
      pendingAttributionFiles("s1", REPO, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toEqual(["src/a.ts"]);
  });

  test("a trailing-slash repo root still strips the prefix", () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    expect(
      pendingAttributionFiles("s1", `${REPO}/`, {
        dbPath,
        liveDirtyPaths: liveDirty(["src/a.ts"]),
      }),
    ).toEqual(["src/a.ts"]);
  });
});

describe("waitForAttributionCaughtUp", () => {
  test("returns true immediately when already caught up (no sleep)", async () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    seedAttribution({ sessionId: "s1", filePath: "src/a.ts" });
    const clock = fakeClock();
    const ok = await waitForAttributionCaughtUp(
      "s1",
      REPO,
      { dbPath, liveDirtyPaths: liveDirty(["src/a.ts"]) },
      { now: clock.now, sleep: clock.sleep },
    );
    expect(ok).toBe(true);
    expect(clock.sleeps).toBe(0);
  });

  test("converges once the producer charges the row mid-wait", async () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    const clock = fakeClock();
    // On the second sleep, simulate the `.1` producer folding a GitSnapshot that
    // charges the row.
    clock.onSleep = (n) => {
      if (n === 2) seedAttribution({ sessionId: "s1", filePath: "src/a.ts" });
    };
    const ok = await waitForAttributionCaughtUp(
      "s1",
      REPO,
      { dbPath, liveDirtyPaths: liveDirty(["src/a.ts"]) },
      { ceilingMs: 10_000, pollMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(ok).toBe(true);
    expect(clock.sleeps).toBe(2);
  });

  test("fails open (returns false) when the producer never catches up", async () => {
    seedMutationEvent({ sessionId: "s1", absPath: `${REPO}/src/a.ts` });
    const clock = fakeClock();
    const ok = await waitForAttributionCaughtUp(
      "s1",
      REPO,
      { dbPath, liveDirtyPaths: liveDirty(["src/a.ts"]) },
      { ceilingMs: 300, pollMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(ok).toBe(false);
    // Bounded: ceiling 300 / poll 100 → at most a handful of polls.
    expect(clock.sleeps).toBeLessThanOrEqual(4);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(300);
  });
});

/**
 * Virtual clock: `now()` reads accumulated time WITHOUT advancing it (faithful
 * to a real monotonic clock that ticks only while blocked), `sleep(ms)` advances
 * it by `ms`. So the bounded wait terminates instantly under a deterministic
 * time model. `onSleep(n)` fires AFTER the n-th sleep advances time so a test can
 * mutate the DB mid-wait to simulate the producer catching up.
 */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number;
  elapsed: () => number;
  onSleep?: (n: number) => void;
} {
  let t = 0;
  const c = {
    now: () => t,
    sleeps: 0,
    elapsed: () => t,
    onSleep: undefined as ((n: number) => void) | undefined,
    sleep: async (ms: number) => {
      t += ms;
      c.sleeps += 1;
      c.onSleep?.(c.sleeps);
    },
  };
  return c;
}
