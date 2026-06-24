/**
 * Startup section progress — a `phase(label)` wrapper that prints one line per
 * section (`~ <label>`) to stdout. Falls silent when `quiet` is true (the
 * default run, `--print`, and passthrough modes) so clean stdout is never
 * polluted; section lines surface at `--agentwrap-verbose`. When `showTiming` is
 * set (`--agentwrap-very-verbose`) a slow phase (>=50ms) adds a `  (Nms)` line
 * beneath its label.
 */

export type Phaser = <T>(label: string, body: () => T) => T;

export function makePhaser(
  quiet: boolean,
  write: (s: string) => void = (s) => process.stdout.write(s),
  showTiming = false,
  now: () => number = () => performance.now(),
): Phaser {
  if (quiet) {
    return <T>(_label: string, body: () => T): T => body();
  }
  return <T>(label: string, body: () => T): T => {
    write(`~ ${label}\n`);
    if (!showTiming) {
      return body();
    }
    const start = now();
    try {
      return body();
    } finally {
      const elapsedMs = Math.trunc(now() - start);
      if (elapsedMs >= 50) {
        write(`  (${elapsedMs}ms)\n`);
      }
    }
  };
}
