/**
 * Dep-free process-starttime parsers shared between the keeper events-writer
 * hook (which MUST NOT import daemon code — hooks import FROM src, never the
 * reverse, see CLAUDE.md Hook rules) and daemon-side consumers
 * (`src/bus-worker.ts`, `src/seed-sweep.ts`) that need the same platform-tagged
 * `(pid, start_time)` recycle identity. `node:*`-only: no `bun:sqlite`, no
 * other keeper module.
 */

/**
 * Pure splitter for the macOS `ps -o lstart=,args=` combined output. COLUMN
 * ORDER MATTERS: `args=` must come LAST so macOS ps doesn't width-truncate it
 * — with args first, `-ww`'s no-truncation promise only applies to the FINAL
 * output line, so the args column still truncates to a hardcoded width and any
 * `--name <token>` past the boundary vanishes. lstart is fixed-width 24 chars,
 * so putting it first lets args trail to the end with full `-ww` widening.
 *
 * Output shape is `<24-char-lstart><≥1-space-padding><args>` — lstart is the
 * libc `ctime(3)`-style `Day Mon DD HH:MM:SS YYYY`.
 */
export function splitArgsLstart(
  out: string,
): { args: string; lstart: string } | null {
  const trimmed = out.replace(/^\s+|\s+$/g, "");
  if (trimmed.length < 24) {
    return null;
  }
  const lstart = trimmed.slice(0, 24);
  // ctime(3) shape: `Xxx Xxx D? HH:MM:SS YYYY` — 1-or-2-digit day padded to
  // width 2 with a leading space.
  if (
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(
      lstart,
    )
  ) {
    return null;
  }
  const args = trimmed.slice(24).replace(/^\s+/, "");
  return { args, lstart };
}

/**
 * Linux `/proc/$pid/stat` field-22 reader (`starttime` in clock ticks since
 * boot — see proc(5)). Field-2 is `(comm)`, which may itself contain spaces
 * and parens, so a naive whitespace split is unsafe; bracket on the LAST `)`
 * then split the remainder. Returns the raw integer string or null.
 */
export function parseLinuxStarttime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // starttime is field 22 overall; comm (field 2) and the `)` are stripped, so
  // it lands at index 19 of `rest`.
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return raw;
}
