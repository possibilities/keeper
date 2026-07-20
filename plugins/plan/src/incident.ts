// Incident surface for the claim / close-preflight envelopes.
//
// A live owning session (a `/plan:work` worker or a `/plan:close` closer) that
// launches against a task/epic carrying an unresolved merge incident learns about
// it from its claim / close-preflight envelope, then can record ownership via
// `keeper incident claim`.
//
// The plan plugin stays sqlite-free: this resolver populates the envelope's
// nullable `incident` field via a BOUNDED READ-ONLY subprocess call of the keeper
// CLI's incident read surface (`keeper escalation-brief <owner-key>`, the
// serve-by-incident-id growth), mirroring the plugin's existing external-command
// idiom (getExec). There is NO keeper.db import into plugins/plan and NO new
// dispatch-time env injection.

import { getExec } from "./exec.ts";

/** Hard wall-clock bound for the keeper read subprocess. */
export const INCIDENT_READ_TIMEOUT_MS = 2_000;
/** Combined child-output cap; the brief fields consumed here are sub-kilobyte. */
export const INCIDENT_READ_MAX_BUFFER_BYTES = 64 * 1024;

/** A live owner's claim on a merge incident, as surfaced in the envelope. */
export interface IncidentClaim {
  session_id: string;
  pid: number | null;
  start_time: string | null;
  claimed_at: number | null;
}

/**
 * The compact incident block a claim / close-preflight envelope surfaces when the
 * owning verb+id carries an unresolved merge incident. `incident_id` is the
 * incident's dispatch key (`work::<taskId>` / `close::<epicId>`) and doubles as
 * `brief_ref` — the handle a session re-fetches the full brief with
 * (`keeper escalation-brief <brief_ref>`), so subagents keep ONE read surface.
 * `instance_event_id` / `attempt_id` are the incident-fenced clear identities the
 * `keeper incident claim --instance <instance_event_id>` call fences on.
 */
export interface EnvelopeIncident {
  incident_id: string;
  kind: string;
  instance_event_id: number | null;
  attempt_id: number | null;
  brief_ref: string;
  grant_ref: string | null;
  claim: IncidentClaim | null;
}

/** The subset of the `keeper escalation-brief` JSON this resolver reads. */
interface BriefEnvelope {
  ok?: unknown;
  kind?: unknown;
  incident?: {
    conflict?: {
      instance_event_id?: unknown;
      attempt_id?: unknown;
      claim?: unknown;
    } | null;
    grant_ref?: unknown;
  };
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce the brief's `conflict.claim` blob into the compact claim, or null. */
function coerceClaim(v: unknown): IncidentClaim | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) {
    return null;
  }
  const c = v as Record<string, unknown>;
  const sessionId = asStringOrNull(c.session_id);
  if (sessionId == null) {
    return null;
  }
  return {
    session_id: sessionId,
    pid: asNumberOrNull(c.pid),
    start_time: asStringOrNull(c.start_time),
    claimed_at: asNumberOrNull(c.claimed_at),
  };
}

/**
 * Resolve the incident (if any) for `ownerKey` (`work::<taskId>` /
 * `close::<epicId>`) via a bounded read-only `keeper escalation-brief` subprocess.
 * Returns the compact incident block when a live merge incident exists, else null
 * (no sticky row, no epic, a non-zero exit, or an unparseable envelope). NEVER
 * throws — a claim / close must never fail on an incident-read hiccup; the field
 * simply stays null.
 */
export function resolveIncident(ownerKey: string): EnvelopeIncident | null {
  let out: string;
  try {
    const res = getExec().run("keeper", ["escalation-brief", ownerKey], {
      timeoutMs: INCIDENT_READ_TIMEOUT_MS,
      maxBufferBytes: INCIDENT_READ_MAX_BUFFER_BYTES,
    });
    // A non-zero exit is `unknown_incident` (the epic exists nowhere), a timeout,
    // or a read fault. Re-check the cap after the seam too so a test/custom
    // PlanExec cannot bypass the production spawn bound.
    if (
      res.exitCode !== 0 ||
      Buffer.byteLength(res.stdout, "utf8") > INCIDENT_READ_MAX_BUFFER_BYTES
    ) {
      return null;
    }
    out = res.stdout;
  } catch {
    return null;
  }

  let parsed: BriefEnvelope;
  try {
    parsed = JSON.parse(out) as BriefEnvelope;
  } catch {
    return null;
  }
  if (parsed.ok !== true) {
    return null;
  }
  const conflict = parsed.incident?.conflict;
  // A found epic with no open merge-conflict row degrades to `conflict: null` —
  // the ordinary "no incident" case.
  if (conflict == null || typeof conflict !== "object") {
    return null;
  }
  return {
    incident_id: ownerKey,
    kind: typeof parsed.kind === "string" ? parsed.kind : "deconflict",
    instance_event_id: asNumberOrNull(conflict.instance_event_id),
    attempt_id: asNumberOrNull(conflict.attempt_id),
    brief_ref: ownerKey,
    grant_ref: asStringOrNull(parsed.incident?.grant_ref),
    claim: coerceClaim(conflict.claim),
  };
}
