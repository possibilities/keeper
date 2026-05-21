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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameFromArgs } from "../plugin/hooks/events-writer";
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

test("a non-SessionStart event leaves spawn_name NULL", async () => {
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
        "SELECT spawn_name FROM events WHERE session_id = 'sess-ups' AND hook_event = 'UserPromptSubmit'",
      )
      .get() as { spawn_name: string | null } | null;
    expect(row?.spawn_name).toBeNull();
  } finally {
    db.close();
  }
});

test("hook exits 0 and writes a row even when the parent argv has no name", async () => {
  // No --name on the launcher argv: the scrape returns null (not a throw), the
  // hook still writes the SessionStart row, and exits 0.
  const code = await fireViaLauncher(null, {
    hook_event_name: "SessionStart",
    session_id: "sess-noname",
    cwd: "/tmp/work",
  });
  expect(code).toBe(0);

  const { db } = openDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT spawn_name FROM events WHERE session_id = 'sess-noname'")
      .get() as { spawn_name: string | null } | null;
    expect(row).not.toBeNull();
    expect(row?.spawn_name).toBeNull();
  } finally {
    db.close();
  }
});
