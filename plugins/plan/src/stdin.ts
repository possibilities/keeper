// Stdin-provider seam — the single overridable source the fd-0 readers draw
// from. In a compiled-binary run the defaults read real fd 0; an in-process
// caller (the bun:test harness's runCli, which dispatches main(argv) directly
// rather than spawning the binary) cannot faithfully replace fd 0, so it
// installs a provider that returns the caller-supplied input and controls the
// TTY signal. The three fd-0 readers (store.readFileOrStdin,
// yaml_input.readYamlBytes, submit_common.readPayloadCapped) route through here
// so one override covers all of them.

import { readFileSync, readSync } from "node:fs";

/** The overridable stdin source. Defaults read real fd 0. */
export interface StdinProvider {
  /** Whole-text read of stdin (UTF-8). */
  readText(): string;
  /** Read up to `cap` bytes off stdin (reject-don't-truncate: an over-cap
   * source yields exactly `cap` bytes so the caller's length check rejects it). */
  readBytes(cap: number): Buffer;
  /** True when stdin is an interactive TTY (the no-silent-keyboard-hang guard). */
  isTTY(): boolean;
}

/** The real-fd-0 default — the production path the compiled binary always runs. */
const realProvider: StdinProvider = {
  readText(): string {
    return readFileSync(0, "utf-8");
  },
  readBytes(cap: number): Buffer {
    return readCappedFd(0, cap);
  },
  isTTY(): boolean {
    return Boolean(process.stdin.isTTY);
  },
};

let active: StdinProvider = realProvider;

/** Install a stdin provider (the in-process harness override). */
export function setStdinProvider(provider: StdinProvider): void {
  active = provider;
}

/** Restore the real-fd-0 default. The harness calls this in `finally`. */
export function resetStdinProvider(): void {
  active = realProvider;
}

/** Whole-text stdin read through the active provider. */
export function readStdinText(): string {
  return active.readText();
}

/** Capped byte read through the active provider. */
export function readStdinBytes(cap: number): Buffer {
  return active.readBytes(cap);
}

/** TTY check through the active provider. */
export function stdinIsTTY(): boolean {
  return active.isTTY();
}

/** Read up to `cap` bytes from `fd` by chunked accumulation, concatenating once
 * at the end. Stops at EOF or once `cap` bytes are in hand — the
 * reject-don't-truncate contract: an over-cap source yields exactly `cap` bytes,
 * which the caller's length check then rejects. */
function readCappedFd(fd: number, cap: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const bufSize = 64 * 1024;
  const buf = Buffer.allocUnsafe(bufSize);
  while (total < cap) {
    const want = Math.min(bufSize, cap - total);
    let n: number;
    try {
      n = readSync(fd, buf, 0, want, null);
    } catch (exc) {
      // EOF on a pipe can surface as EAGAIN/EOF depending on platform; treat a
      // genuine end-of-input as a clean stop, re-raise anything else.
      if (isEof(exc)) {
        break;
      }
      throw exc;
    }
    if (n === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks, total);
}

function isEof(exc: unknown): boolean {
  return (
    typeof exc === "object" &&
    exc !== null &&
    (exc as { code?: string }).code === "EOF"
  );
}
