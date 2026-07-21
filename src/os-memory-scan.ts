export const OS_MEMORY_KILL_EVIDENCE_MAX_LEN = 300;

export interface OsMemoryKillWindow {
  pid: number;
  startedAtMs: number;
  diedAtMs: number;
}

export interface OsMemoryKillEvidence {
  reason: string;
}

/**
 * A jetsam/memory-pressure kill line names the victim pid, a kill verb, AND
 * one of the OS memory-management subsystem tokens — ORDER-INDEPENDENT (real
 * lines phrase it both ways, e.g. "jetsam ... killing" and "killing ...
 * (jetsam)"). Requiring both independently rejects the constant background
 * chatter runningboardd emits for every process ("is not RunningBoard jetsam
 * managed", "Ignoring jetsam update"), which never carries a kill verb.
 */
const KILL_VERB_PATTERN = /\b(?:kill|killed|killing|sigkill)\b/i;
const JETSAM_SUBSYSTEM_PATTERN =
  /(?:\bjetsam\b|memorystatus_kill|\blow swap\b|\bhighwater\b|vm-?pageout|memory[- ]?pressure)/i;

function bounded(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > OS_MEMORY_KILL_EVIDENCE_MAX_LEN
    ? trimmed.slice(0, OS_MEMORY_KILL_EVIDENCE_MAX_LEN)
    : trimmed;
}

/**
 * Pure line scanner over already-fetched `log show` text (the fetch itself is
 * a thin, untested production wrapper — see `probeOsMemoryKillEvidence` in
 * daemon.ts). A line counts as evidence only when it BOTH names the victim
 * pid and matches a known jetsam-kill shape, so ambient runningboardd/jetsam
 * noise about unrelated processes never false-positives.
 */
export function findOsMemoryKillEvidence(
  logText: string,
  window: OsMemoryKillWindow,
): OsMemoryKillEvidence | null {
  if (logText.trim().length === 0) return null;
  const pidToken = String(window.pid);
  for (const rawLine of logText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.includes(pidToken)) continue;
    if (KILL_VERB_PATTERN.test(line) && JETSAM_SUBSYSTEM_PATTERN.test(line)) {
      return { reason: bounded(line) };
    }
  }
  return null;
}
