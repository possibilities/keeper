/**
 * Shared Nerd Font robot status icons for Keeper jobs. The six-rung ladder
 * combines the four lifecycle states with the two live attention annotations;
 * terminal lifecycle states outrank stale annotations, then error/awaiting
 * outrank the working/stopped base state. Unknown states fail calm to stopped.
 */

import type { Job } from "./types";

/** Status rungs represented by distinct Material Design robot faces. */
export type RobotRung =
  | "error"
  | "awaiting"
  | "working"
  | "ended"
  | "stopped"
  | "killed";

/** Nerd Font Material Design robot codepoints, one face per status rung. */
const ROBOT_CP: Record<RobotRung, string> = {
  error: "f169d", // robot_angry
  awaiting: "f169f", // robot_confused
  working: "f06a9", // robot
  ended: "f1719", // robot_happy
  stopped: "f167a", // robot_outline
  killed: "f16a1", // robot_dead
};

/** Materialize one status rung as its Nerd Font robot glyph. */
export function robotGlyph(rung: RobotRung): string {
  return String.fromCodePoint(Number.parseInt(ROBOT_CP[rung], 16));
}

/**
 * Derive a job's status rung from lifecycle state and attention annotations.
 * Terminal state wins over stale annotations; otherwise API error, awaiting
 * human input, working, then stopped. Unknown states use the stopped outline.
 */
export function robotRung(job: Job): RobotRung {
  if (job.state === "ended") {
    return "ended";
  }
  if (job.state === "killed") {
    return "killed";
  }
  if (job.last_api_error_at != null) {
    return "error";
  }
  if (
    job.last_permission_prompt_at != null ||
    job.last_input_request_at != null
  ) {
    return "awaiting";
  }
  return job.state === "working" ? "working" : "stopped";
}
