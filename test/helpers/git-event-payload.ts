import type { Database } from "bun:sqlite";

/**
 * Make legacy reducer fixtures match the current producer wire contract.
 * Production captures this watermark immediately before reading Git; tests build
 * the observed status inline, so the event-log head immediately before INSERT is
 * the equivalent deterministic boundary.
 */
export function bindGitObservationWatermark(
  db: Database,
  hookEvent: string,
  data: string,
): string {
  if (hookEvent !== "GitSnapshot" && hookEvent !== "GitRootDropped") {
    return data;
  }

  let parsed: unknown;
  try {
    parsed = data.length === 0 ? {} : JSON.parse(data);
  } catch {
    return data;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    "attribution_event_id" in parsed
  ) {
    return data;
  }

  if (hookEvent === "GitRootDropped") {
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      attribution_event_id: null,
    });
  }

  const head = (
    db.query("SELECT MAX(id) AS id FROM events").get() as {
      id: number | null;
    } | null
  )?.id;
  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    attribution_event_id: head ?? 0,
  });
}
