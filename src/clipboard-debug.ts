/**
 * Shared "copy debug snapshot to clipboard" plumbing for the live keeper
 * scripts (`scripts/board.ts`, `scripts/autopilot.ts`, `scripts/git.ts`,
 * `scripts/usage.ts`). Each script binds `c` through the live-shell's
 * `onUnhandledKey` and calls into here.
 *
 * The payload is hand-formatted markdown-ish text: a leading prose block
 * naming the script + frame, then the rendered frame inline, then a
 * `## Full state` section pointing at the JSON sidecar (path-only — state
 * blobs can be hundreds of KB and would dwarf the rest of the clipboard),
 * then the other per-frame and session-level sidecar paths. The shape is
 * stable across all four scripts so a recipient can scan any paste the
 * same way.
 *
 * `buildDebugSnapshot` is pure string→string and tests can exercise it
 * without spawning anything. `copyToClipboard` spawns `pbcopy` (macOS
 * only — this repo is darwin per `CLAUDE.md`) and returns a discriminated
 * union so the caller can flash a `[copied frame N]` vs. `[copy failed]`
 * banner via `liveShell.setStatus`.
 */

export interface DebugSnapshotInputs {
  /**
   * Script name without the `keeper-` prefix — `"board" | "autopilot" |
   * "git" | "usage"`. Drives the human-readable header AND the sidecar
   * basename (`/tmp/keeper-<script>.<pid>.…`).
   */
  readonly script: string;
  /** Process pid — derives the sidecar paths. */
  readonly pid: number;
  /**
   * Rendered frame text — the same string the script wrote to its
   * `<script>.<pid>.frame.<n>.txt` sidecar (no banner, leading `---` is
   * fine).
   */
  readonly frame: string;
  /** Current frame counter — the `<n>` in the per-frame sidecar paths. */
  readonly frameNumber: number;
  /** Session-level meta sidecar path (the index of all per-frame files). */
  readonly metaSidecar: string;
  /** Session-level lifecycle sidecar path (warn / connection events). */
  readonly lifecycleSidecar: string;
  /**
   * ISO timestamp to stamp into the header. Injectable so tests get
   * deterministic output; production passes `new Date().toISOString()`.
   */
  readonly nowIso: string;
}

/**
 * Build the clipboard payload. Pure: no IO, no `Date.now()`, no env
 * reads — the timestamp is an explicit input.
 */
export function buildDebugSnapshot(input: DebugSnapshotInputs): string {
  const frame = Bun.stripANSI(input.frame);
  const statePath = `/tmp/keeper-${input.script}.${input.pid}.state.${input.frameNumber}.json`;
  const framePath = `/tmp/keeper-${input.script}.${input.pid}.frame.${input.frameNumber}.txt`;
  const diffPath = `/tmp/keeper-${input.script}.${input.pid}.diff.${input.frameNumber}.txt`;
  return [
    `This is the current state from keeper-${input.script} (pid ${input.pid}, frame ${input.frameNumber}, captured at ${input.nowIso}).`,
    `The block below is what's on screen right now. The full state used to build it is at the path under "Full state" — read it from disk; it's not inlined here because state JSON blobs can be large.`,
    "",
    "## Frame",
    "",
    frame,
    "",
    "## Full state",
    "",
    statePath,
    "",
    "## Other debug files",
    "",
    `  frame text:    ${framePath}`,
    `  unified diff:  ${diffPath}`,
    `  session meta:  ${input.metaSidecar}`,
    `  lifecycle log: ${input.lifecycleSidecar}`,
    "",
  ].join("\n");
}

export { type CopyResult, copyToClipboard } from "./clipboard";
