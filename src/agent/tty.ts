/**
 * Single-character raw terminal read for the cwd-confirm prompt — the bun:ffi
 * equivalent of Python's `termios.tcsetattr` + `tty.setraw` (`read -sk1`).
 *
 * tcgetattr/tcsetattr live in libc; we dlopen the same library FileLock binds
 * (libSystem on darwin, libc.so.6 on linux) and clear ICANON|ECHO for exactly
 * one byte, then restore. A `process.on("exit")` restore is registered BEFORE
 * entering raw mode so a mid-read signal can't strand the TTY in raw mode; the
 * try/finally restores on the normal path. bun:ffi is experimental — pin bun.
 *
 * `struct termios` is read/written as an opaque byte buffer: we only toggle two
 * bits in `c_lflag`, whose offset and width differ per platform, so the layout
 * is pinned by the platform-keyed constants below rather than parsed.
 */

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { readSync } from "node:fs";

// `struct termios` c_lflag offset, per platform — tcflag_t width differs, so
// the field offset does too. Both are ABI-stable.
//   darwin: tcflag_t is 8 bytes; layout {iflag@0, oflag@8, cflag@16, lflag@24,
//     cc[20], ispeed, ospeed} → c_lflag at offset 24, struct 72 bytes.
//   linux (glibc): tcflag_t is 4 bytes; layout {iflag@0, oflag@4, cflag@8,
//     lflag@12, line, cc[32], ispeed, ospeed} → c_lflag at offset 12, struct
//     60 bytes.
// TERMIOS_SIZE over-allocates for both so the opaque buffer always fits.
const TERMIOS_SIZE = 128;
const LFLAG_OFFSET = process.platform === "darwin" ? 24 : 12;

// c_lflag bits cleared for raw single-char input, from <termios.h>. ICANON
// differs per platform; ECHO is 0x8 on both.
//   darwin: ICANON = 0x100; linux (glibc): ICANON = 0x2.
const ICANON = process.platform === "darwin" ? 0x00000100 : 0x00000002;
const ECHO_BIT = 0x00000008; // darwin & linux: 0o010 == 0x8

// tcsetattr action: apply after draining output. darwin/linux both use 1.
const TCSADRAIN = 1;

interface TermiosLib {
  tcgetattr: (fd: number, buf: unknown) => number;
  tcsetattr: (fd: number, action: number, buf: unknown) => number;
  close: () => void;
}

function loadTermios(): TermiosLib {
  const libName =
    process.platform === "darwin" ? `libSystem.${suffix}` : `libc.${suffix}.6`;
  const lib = dlopen(libName, {
    tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcsetattr: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const syms = lib.symbols as unknown as {
    tcgetattr: TermiosLib["tcgetattr"];
    tcsetattr: TermiosLib["tcsetattr"];
  };
  return {
    tcgetattr: syms.tcgetattr,
    tcsetattr: syms.tcsetattr,
    close: () => lib.close(),
  };
}

/**
 * Read a single character from stdin without echo (like zsh's `read -sk1`).
 * Saves the current termios, clears ICANON|ECHO, reads one byte, and restores
 * in a finally. An exit-time restore is registered before raw mode is entered
 * so a signal that kills the process mid-read still leaves the TTY usable.
 */
export function readSingleChar(): string {
  const fd = 0; // stdin
  const lib = loadTermios();
  const saved = new Uint8Array(TERMIOS_SIZE);
  const work = new Uint8Array(TERMIOS_SIZE);

  if (lib.tcgetattr(fd, ptr(saved)) !== 0) {
    // No TTY / not a terminal — fall back to a plain blocking read of one byte.
    lib.close();
    return readOneByte(fd);
  }

  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    lib.tcsetattr(fd, TCSADRAIN, ptr(saved));
  };
  // Register the exit restore BEFORE entering raw mode (best-practices note).
  process.on("exit", restore);

  try {
    work.set(saved);
    // Clear ICANON | ECHO in c_lflag via a u32 little-endian read-modify-write
    // at LFLAG_OFFSET. On darwin the field is 8 bytes wide, but every
    // meaningful lflag bit lives in the low word; the u32 RMW touches only that
    // low word and never writes the high padding bytes (offset+4..offset+7),
    // which it has no need to clear. On linux the field is exactly the u32.
    const view = new DataView(work.buffer);
    const lflag = view.getUint32(LFLAG_OFFSET, true);
    view.setUint32(LFLAG_OFFSET, lflag & ~(ICANON | ECHO_BIT), true);
    lib.tcsetattr(fd, TCSADRAIN, ptr(work));
    return readOneByte(fd);
  } finally {
    restore();
    process.removeListener("exit", restore);
    lib.close();
  }
}

/** Blocking read of exactly one byte from `fd`, decoded as UTF-8 (or ""). */
function readOneByte(fd: number): string {
  const buf = Buffer.alloc(1);
  const n = readSync(fd, buf, 0, 1, null);
  if (n <= 0) {
    return "";
  }
  return buf.toString("utf8");
}
