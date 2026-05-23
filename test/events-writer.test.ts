/**
 * Tests for the events-writer hook's spawn-name capture (fn-545).
 *
 * Two layers:
 * - `nameFromArgs` unit cases — the pure, exported flag parser. All flag forms
 *   (`--name=X` / `--name X` / `-n X`) parse to a single token; flag-boundary
 *   anchoring rejects `--rename`/`--username`; absent/empty → null.
 * - Hook-process integration — drive the real hook as a spawned process whose
 *   PARENT argv carries `--name <session>`, and assert: SessionStart populates
 *   `events.spawn_name`; a non-SessionStart event leaves it NULL; the hook
 *   always exits 0 even when the `ps` scrape can't find a name.
 *
 * The parent-argv carrier is a tiny launcher script (`spawn-launcher.ts`)
 * written into the tmpdir: when run as `bun run spawn-launcher.ts --name <X>`,
 * IT becomes the hook's parent (`process.ppid`), so the hook's
 * `ps -p <ppid> -o args=` scrape sees the `--name` flag exactly as it would
 * under the real arthack-claude launcher.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nameFromArgs,
  parseLinuxStarttime,
  splitArgsLstart,
} from "../plugin/hooks/events-writer";
import { openDb } from "../src/db";

const ROOT = join(import.meta.dir, "..");
const HOOK_ENTRY = join(ROOT, "plugin", "hooks", "events-writer.ts");

let tmpDir: string;
let dbPath: string;
let launcherPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-events-writer-test-"));
  dbPath = join(tmpDir, "keeper.db");
  launcherPath = join(tmpDir, "spawn-launcher.ts");
  // The launcher pipes a payload (its first non-flag arg after the marker) into
  // the hook on stdin and exits with the hook's code. Its OWN argv carries the
  // `--name <session>` flag, so the hook's parent (= this launcher process)
  // exposes the flag to `ps`.
  writeFileSync(
    launcherPath,
    `
const HOOK = ${JSON.stringify(HOOK_ENTRY)};
// Everything after "--payload" is the JSON payload to pipe to the hook.
const idx = process.argv.indexOf("--payload");
const payload = idx >= 0 ? process.argv[idx + 1] : "{}";
const proc = Bun.spawn(["bun", HOOK], {
  env: process.env,
  stdin: new TextEncoder().encode(payload),
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
process.exit(code);
`,
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the launcher with a given session name + payload; resolve its exit code. */
async function fireViaLauncher(
  sessionName: string | null,
  payload: Record<string, unknown>,
): Promise<number> {
  const args = ["bun", "run", launcherPath];
  if (sessionName !== null) {
    args.push("--name", sessionName);
  }
  args.push("--payload", JSON.stringify(payload));
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: { ...process.env, KEEPER_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

// ---------------------------------------------------------------------------
// nameFromArgs unit
// ---------------------------------------------------------------------------

test("nameFromArgs parses --name=foo", () => {
  expect(nameFromArgs("/path/to/claude --name=foo --other")).toBe("foo");
});

test("nameFromArgs parses --name foo", () => {
  expect(nameFromArgs("/path/to/claude --name foo --other")).toBe("foo");
});

test("nameFromArgs parses -n foo", () => {
  expect(nameFromArgs("/path/to/claude -n foo --other")).toBe("foo");
});

test("nameFromArgs captures a single token (multi-word truncates)", () => {
  // `ps` space-joins argv; a multi-word name is indistinguishable from trailing
  // args, so only the first token is captured (locked single-token policy).
  expect(nameFromArgs("claude --name foo bar baz")).toBe("foo");
});

test("nameFromArgs does not false-match --rename or --username", () => {
  expect(nameFromArgs("claude --rename foo")).toBeNull();
  expect(nameFromArgs("claude --username foo")).toBeNull();
});

test("nameFromArgs returns null when no name flag is present", () => {
  expect(nameFromArgs("/path/to/claude --resume --model opus")).toBeNull();
});

test("nameFromArgs returns null on an empty string", () => {
  expect(nameFromArgs("")).toBeNull();
});

test("nameFromArgs matches a --name flag at the very start of the string", () => {
  expect(nameFromArgs("--name foo")).toBe("foo");
});

// ---------------------------------------------------------------------------
// Hook process integration
// ---------------------------------------------------------------------------

test("SessionStart populates events.spawn_name from the parent argv --name", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "SessionStart",
    session_id: "sess-spawn",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name FROM events WHERE session_id = 'sess-spawn' AND hook_event = 'SessionStart'",
      )
      .get() as { spawn_name: string | null } | null;
    expect(row?.spawn_name).toBe("my-session");
  } finally {
    db.close();
  }
});

test("SessionStart populates events.start_time platform-tagged", async () => {
  // The ps/proc probe runs against this test process's launcher — so the
  // captured start_time is a real, live value. We don't assert the exact text
  // (it's opaque), only that it is populated and carries the platform prefix
  // matching the current OS.
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "SessionStart",
    session_id: "sess-stime",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT start_time FROM events WHERE session_id = 'sess-stime' AND hook_event = 'SessionStart'",
      )
      .get() as { start_time: string | null } | null;
    expect(row?.start_time).not.toBeNull();
    const expectedPrefix =
      process.platform === "darwin"
        ? "darwin:"
        : process.platform === "linux"
          ? "linux:"
          : null;
    if (expectedPrefix !== null) {
      expect(row?.start_time?.startsWith(expectedPrefix)).toBe(true);
      // Body after the prefix is non-empty (24-char lstart / digit jiffies).
      expect(
        (row?.start_time?.slice(expectedPrefix.length) ?? "").length,
      ).toBeGreaterThan(0);
    }
  } finally {
    db.close();
  }
});

test("a non-SessionStart event leaves spawn_name AND start_time NULL", async () => {
  const code = await fireViaLauncher("my-session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-ups",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-ups' AND hook_event = 'UserPromptSubmit'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row?.spawn_name).toBeNull();
    expect(row?.start_time).toBeNull();
  } finally {
    db.close();
  }
});

test("hook exits 0 and writes a row even when the parent argv has no name", async () => {
  // No --name on the launcher argv: the scrape returns null (not a throw), the
  // hook still writes the SessionStart row, and exits 0. start_time still
  // comes back populated — the same single probe captures it, --name absence
  // doesn't break the lstart half.
  const code = await fireViaLauncher(null, {
    hook_event_name: "SessionStart",
    session_id: "sess-noname",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-noname'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.spawn_name).toBeNull();
    // start_time should still populate on supported platforms; we don't strand
    // it on the no-name path.
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(row?.start_time).not.toBeNull();
    }
  } finally {
    db.close();
  }
});

test("hook exits 0 with NULL start_time when the ps probe is force-broken", async () => {
  // Force-failure path: prepend a tmpdir to PATH that shadows `ps` with a
  // bash script exiting 1 (mimics a wedged/missing ps without removing
  // /bin/sh). The hook MUST swallow the failure, exit 0, and write the row
  // with start_time = NULL (and spawn_name = NULL on darwin since the same
  // probe yields both fields). On linux this won't break the /proc reads, so
  // the assertion only requires that the hook exits 0 and the row exists.
  const shadowDir = join(tmpDir, "shadow-bin");
  mkdirSync(shadowDir, { recursive: true });
  const fakePs = join(shadowDir, "ps");
  writeFileSync(fakePs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  // Reuse the launcher but inject the shadowed PATH via a wrapper env on the
  // spawn. We do it inline instead of through fireViaLauncher so this test
  // controls env without touching the shared helper.
  const args = [
    "bun",
    "run",
    launcherPath,
    "--name",
    "shadowed",
    "--payload",
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-broken-ps",
      cwd: "/tmp/work",
    }),
  ];
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: {
      ...process.env,
      KEEPER_DB: dbPath,
      PATH: `${shadowDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess-broken-ps'",
      )
      .get() as { spawn_name: string | null; start_time: string | null } | null;
    expect(row).not.toBeNull();
    if (process.platform === "darwin") {
      // Darwin path: the single ps probe yields BOTH fields, so a broken ps
      // strands both as NULL.
      expect(row?.spawn_name).toBeNull();
      expect(row?.start_time).toBeNull();
    }
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// splitArgsLstart unit (Darwin column-split)
// ---------------------------------------------------------------------------

test("splitArgsLstart peels a 24-char lstart off the leading edge", () => {
  // Real-shape sample: 24-char lstart + ≥1 space padding + args.
  const sample = "Sat May 23 10:46:29 2026     /bin/zsh -c source\n";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.args).toBe("/bin/zsh -c source");
  expect(got?.lstart).toBe("Sat May 23 10:46:29 2026");
});

test("splitArgsLstart handles single-digit day padding (space-padded)", () => {
  // ctime(3) left-pads single-digit days with a leading space: ` 7` not `07`.
  const sample = "Mon Jan  7 03:04:05 2025     /usr/bin/foo\n";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.lstart).toBe("Mon Jan  7 03:04:05 2025");
  expect(got?.args).toBe("/usr/bin/foo");
});

test("splitArgsLstart preserves args verbatim including --name flag", () => {
  // The whole point of putting lstart FIRST: macOS ps doesn't truncate args
  // when it's the last column, so the launcher's --name <token> survives even
  // for long argv lines that would have been clipped under `args=,lstart=`.
  const sample =
    "Sat May 23 10:46:29 2026     bun run /tmp/spawn-launcher.ts --name my-session --payload xxx";
  const got = splitArgsLstart(sample);
  expect(got).not.toBeNull();
  expect(got?.args).toBe(
    "bun run /tmp/spawn-launcher.ts --name my-session --payload xxx",
  );
});

test("splitArgsLstart rejects a malformed leading field", () => {
  // Leading 24 chars don't match the ctime(3) shape — return null rather than
  // feeding garbage downstream.
  expect(splitArgsLstart("not a real lstart here /some/proc")).toBeNull();
});

test("splitArgsLstart rejects a string shorter than the lstart width", () => {
  expect(splitArgsLstart("short")).toBeNull();
  expect(splitArgsLstart("")).toBeNull();
});

// ---------------------------------------------------------------------------
// parseLinuxStarttime unit (Linux /proc/PID/stat field 22)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic /proc/PID/stat where fields after `(comm)` are
 * `state, ppid, pgrp, ..., itrealvalue, starttime, ...` — placing
 * `starttime` (overall field 22, 20th field after comm) at index 19 of
 * the post-comm split. The helper accepts a starttime token so a test
 * can inject a non-numeric value to exercise the validation branch.
 */
function buildStat(
  comm: string,
  starttime: string,
  trailing = "999 888",
): string {
  const beforeStarttime: string[] = [];
  // 19 placeholder fields: state, ppid, pgrp, session, tty_nr, tpgid, flags,
  // minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority,
  // nice, num_threads, itrealvalue. Values don't matter to the parser; they
  // just hold positions.
  beforeStarttime.push("S"); // state
  for (let i = 1; i < 19; i++) {
    beforeStarttime.push(String(i));
  }
  return `42 (${comm}) ${beforeStarttime.join(" ")} ${starttime} ${trailing}\n`;
}

test("parseLinuxStarttime extracts field 22 from a real-shape stat line", () => {
  expect(parseLinuxStarttime(buildStat("my-proc", "12345"))).toBe("12345");
});

test("parseLinuxStarttime handles a comm with spaces and parens", () => {
  // comm field can contain anything including `(` `)` ` ` — proc(5) says the
  // canonical parser brackets on the LAST `)`. Use a comm that embeds both.
  expect(parseLinuxStarttime(buildStat("some (nested) comm", "77777"))).toBe(
    "77777",
  );
});

test("parseLinuxStarttime returns null on a malformed stat line (no closing paren)", () => {
  expect(parseLinuxStarttime("42 some comm no parens here")).toBeNull();
});

test("parseLinuxStarttime returns null when field 22 is non-numeric", () => {
  expect(parseLinuxStarttime(buildStat("proc", "not-a-number"))).toBeNull();
});
