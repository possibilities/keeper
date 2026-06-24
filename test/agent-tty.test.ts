/**
 * Termios tripwire (CLAUDE.md FFI invariant). The cwd-confirm prompt clears
 * ICANON|ECHO in `struct termios.c_lflag` via a u32 little-endian RMW at a
 * platform-keyed offset (src/tty.ts). The offset and ICANON bit are different
 * on darwin (lflag@24, ICANON 0x100) vs linux (lflag@12, ICANON 0x2); getting
 * either wrong silently leaves canonical mode on, so the prompt blocks until
 * Enter with the keystroke echoed — the exact bug this suite guards against.
 *
 * bun test runs piped, so fd 0 here is not a tty. We allocate a real pty with
 * script(1) and run a probe child inside it. The child reads the live termios
 * off the pty, applies the same masking tty.ts uses, reads it back, and asserts
 * ICANON is actually cleared then restored — assertions run inside the pty
 * child (per best-practices), and the harness only checks the child's exit
 * status and result line. Skips cleanly when script/pty is unavailable.
 *
 * Manual end-to-end proof (how the bug was demonstrated): drive a readSingleChar
 * probe under expect(1), send a single "y" with no newline — it returns
 * immediately, un-echoed. Before the offset/ICANON fix it hangs until Enter.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function haveScript(): boolean {
  const r = spawnSync("sh", ["-c", "command -v script"], { stdio: "ignore" });
  return r.status === 0;
}

const SCRIPT_AVAILABLE = haveScript();

// Probe child: runs inside a script(1)-allocated pty with fd 0 = the pty. It
// re-derives the platform-keyed constants tty.ts uses, clears ICANON|ECHO via
// the same u32 RMW, reads termios back, and proves ICANON cleared then restored.
// It prints exactly one machine-parseable result line and exits non-zero on any
// failed invariant so the harness can assert on both the line and the status.
const PROBE_SRC = `
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const fd = 0;
const LFLAG_OFFSET = process.platform === "darwin" ? 24 : 12;
const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
const ECHO_BIT = 0x8;
const TCSADRAIN = 1;
const SIZE = 128;

function fail(msg) {
  console.log("PROBE_RESULT fail " + msg);
  process.exit(1);
}

const libName =
  process.platform === "darwin" ? \`libSystem.\${suffix}\` : \`libc.\${suffix}.6\`;
const lib = dlopen(libName, {
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcsetattr: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
});
const { tcgetattr, tcsetattr } = lib.symbols;

const saved = new Uint8Array(SIZE);
if (tcgetattr(fd, ptr(saved)) !== 0) fail("tcgetattr_initial");

const savedView = new DataView(saved.buffer);
const savedLflag = savedView.getUint32(LFLAG_OFFSET, true);
if ((savedLflag & ICANON) === 0) fail("icanon_not_set_initially");

const work = new Uint8Array(SIZE);
work.set(saved);
const workView = new DataView(work.buffer);
const lflag = workView.getUint32(LFLAG_OFFSET, true);
workView.setUint32(LFLAG_OFFSET, lflag & ~(ICANON | ECHO_BIT), true);
if (tcsetattr(fd, TCSADRAIN, ptr(work)) !== 0) fail("tcsetattr_raw");

// Read back the live termios — the kernel's view, not our work buffer.
const after = new Uint8Array(SIZE);
if (tcgetattr(fd, ptr(after)) !== 0) fail("tcgetattr_after_raw");
const afterLflag = new DataView(after.buffer).getUint32(LFLAG_OFFSET, true);
if ((afterLflag & ICANON) !== 0) fail("icanon_still_set");
if ((afterLflag & ECHO_BIT) !== 0) fail("echo_still_set");

// Restore and confirm ICANON came back.
if (tcsetattr(fd, TCSADRAIN, ptr(saved)) !== 0) fail("tcsetattr_restore");
const restored = new Uint8Array(SIZE);
if (tcgetattr(fd, ptr(restored)) !== 0) fail("tcgetattr_restored");
const restoredLflag = new DataView(restored.buffer).getUint32(LFLAG_OFFSET, true);
if ((restoredLflag & ICANON) === 0) fail("icanon_not_restored");

lib.close();
console.log("PROBE_RESULT ok cleared_and_restored");
process.exit(0);
`;

let dir: string;
let probePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentwrap-tty-"));
  probePath = join(dir, "probe.ts");
  writeFileSync(probePath, PROBE_SRC);
});

afterAll(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// script(1) is two incompatible CLIs: darwin (BSD) takes the command as
// positional args after the typescript file and rejects -c; util-linux requires
// -c '<cmd>'. Branch on platform; never pass -c on darwin.
function runUnderPty(): { stdout: string; status: number | null } {
  const bun = process.execPath;
  if (process.platform === "darwin") {
    const r = spawnSync("script", ["-q", "/dev/null", bun, probePath], {
      encoding: "utf8",
    });
    return { stdout: r.stdout ?? "", status: r.status };
  }
  const cmd = `${bun} ${probePath}`;
  const r = spawnSync("script", ["-q", "-e", "-c", cmd, "/dev/null"], {
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", status: r.status };
}

test.skipIf(!SCRIPT_AVAILABLE)(
  "clears ICANON|ECHO under a real pty and restores them",
  () => {
    const { stdout, status } = runUnderPty();
    const line = stdout.split(/\r?\n/).find((l) => l.includes("PROBE_RESULT"));
    expect(line, `no PROBE_RESULT line in:\n${stdout}`).toBeDefined();
    expect(line).toContain("PROBE_RESULT ok cleared_and_restored");
    expect(status).toBe(0);
  },
);
