/**
 * Agent Bus two-layer name resolution (epic fn-875). The keystone correctness
 * surface: an agent reachable by its CURRENT name must ALSO be reachable by ANY
 * FORMER name (dead-name resolution), symmetric for reach and reply.
 *
 * PURE over its inputs — `(live channel set, read-only keeper.db handle, target)`
 * — so every resolution path unit-tests in-process via `freshMemDb()` seeding a
 * synthetic `jobs` table. No env / tmux / cwd / `Date.now()` reads; the impure
 * I/O (DB open, clock) lives in the worker and arrives as plain data.
 *
 * Two layers:
 *  - Layer 2 (identity) — resolve the target NAME to a stable keeper identity by
 *    consulting ALL `jobs` (not just live channels): exact on session_id / pid /
 *    current title / ANY `name_history` entry → prefix on ids → substring on the
 *    CURRENT TITLE ONLY. Append-only `name_history` makes an old/dead name map
 *    deterministically to the same agent.
 *  - Layer 1 (delivery) — map the resolved identity (or, on a keeper miss, the
 *    raw target) to a CURRENT live channel.
 *
 * Fail-soft: a keeper miss does NOT error — it falls back to the live registry
 * (a just-started agent whose pid is not yet folded into `jobs` is reachable by
 * its register-frame name). Ambiguity is deterministic: prefer a LIVE channel,
 * else the newest job by `updated_at`.
 */

import type { Database } from "bun:sqlite";

/**
 * The live, in-memory channel set the worker hands the resolver — Layer 1. A
 * subset of the bus's `ChannelRow` shape carrying only the resolution-relevant
 * fields, so the resolver stays decoupled from the storage row type.
 */
export interface LiveChannel {
  channel_id: string;
  pid: number;
  start_time: string;
  session_id: string | null;
  current_name: string | null;
  /** Oldest→newest session names. */
  name_history: string[];
}

/** A stable keeper identity resolved from `jobs` (Layer 2 output). */
export interface ResolvedIdentity {
  job_id: string;
  pid: number | null;
  start_time: string | null;
  title: string | null;
  name_history: string[];
}

/** Resolution method label — echoed for diagnostics. */
export type ResolveMethod =
  | "live-exact"
  | "jobs-exact"
  | "jobs-prefix"
  | "jobs-substring"
  | "live-fallback"
  | "unknown";

export type BusResolveResult =
  | {
      kind: "ok";
      method: ResolveMethod;
      /** The live channel to deliver to (present when the agent is on the bus NOW). */
      channel: LiveChannel | null;
      /** The keeper identity (present when keeper knew the agent). */
      identity: ResolvedIdentity | null;
    }
  | { kind: "ambiguous"; method: ResolveMethod; identities: ResolvedIdentity[] }
  | { kind: "unknown"; target: string };

const LIVE_PREFER_ORDER = `
  COALESCE(updated_at, created_at) DESC,
  job_id ASC`;

/** Map a raw `jobs` row to a {@link ResolvedIdentity}. */
function rowToIdentity(row: Record<string, unknown>): ResolvedIdentity {
  let history: string[] = [];
  const cell = row.name_history;
  if (typeof cell === "string" && cell.length > 0) {
    try {
      const parsed = JSON.parse(cell);
      if (Array.isArray(parsed)) history = parsed.map((v) => String(v));
    } catch {
      history = [];
    }
  }
  return {
    job_id: String(row.job_id),
    pid: row.pid == null ? null : Number(row.pid),
    start_time: row.start_time == null ? null : String(row.start_time),
    title: row.title == null ? null : String(row.title),
    name_history: history,
  };
}

/**
 * Find the live channel for a resolved identity — Layer 1 over Layer 2's output.
 * Matches on the stable `(pid, start_time)` identity first (defeats pid reuse),
 * then on `session_id == job_id`. Returns null when the agent is not on the bus.
 */
function liveChannelForIdentity(
  channels: LiveChannel[],
  id: ResolvedIdentity,
): LiveChannel | null {
  if (id.pid != null && id.start_time != null) {
    const byIdentity = channels.find(
      (c) => c.pid === id.pid && c.start_time === id.start_time,
    );
    if (byIdentity) return byIdentity;
  }
  const bySession = channels.find((c) => c.session_id === id.job_id);
  return bySession ?? null;
}

/**
 * Layer 1 ONLY — match a target directly against the live channel set. The
 * fail-soft path when keeper.db knows nothing of the agent (resume gap). Exact
 * on session_id / pid / current_name / ANY name_history entry (NOCASE on names).
 */
function matchLiveExact(
  channels: LiveChannel[],
  target: string,
): LiveChannel[] {
  const needle = target.toLowerCase();
  const asInt = /^\d+$/.test(target) ? Number(target) : null;
  return channels.filter(
    (c) =>
      c.session_id === target ||
      (asInt != null && c.pid === asInt) ||
      (c.current_name != null && c.current_name.toLowerCase() === needle) ||
      c.name_history.some((n) => n.toLowerCase() === needle),
  );
}

/**
 * Resolve `jobs` rows for a target at one tier. Tier `exact` ANDs the
 * cross-field exact predicate (session_id / pid / current title / ANY
 * name_history entry, NOCASE on titles); `prefix` matches job_id/start ids by
 * prefix; `substring` matches the CURRENT TITLE ONLY (history is exact-only — a
 * substring over old names creates spooky false positives from forgotten
 * sessions, per the chatctl resolution model). Bound params only — never
 * string-interpolated.
 */
function jobsAtTier(
  db: Database,
  target: string,
  tier: "exact" | "prefix" | "substring",
): ResolvedIdentity[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (tier === "exact") {
    const asInt = /^\d+$/.test(target) ? Number(target) : null;
    where.push("job_id = ?");
    params.push(target);
    where.push("title = ? COLLATE NOCASE");
    params.push(target);
    where.push(`EXISTS (
      SELECT 1 FROM json_each(COALESCE(name_history, '[]')) je
       WHERE je.value = ? COLLATE NOCASE)`);
    params.push(target);
    if (asInt != null) {
      where.push("pid = ?");
      params.push(asInt);
    }
  } else if (tier === "prefix") {
    where.push("job_id LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(target)}%`);
  } else {
    where.push("title LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escapeLike(target)}%`);
  }
  const sql = `SELECT job_id, pid, start_time, title, name_history
    FROM jobs WHERE (${where.join(" OR ")})
    ORDER BY ${LIVE_PREFER_ORDER}`;
  const rows = db.prepare(sql).all(...(params as never[])) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToIdentity);
}

/** Escape LIKE wildcards so a target with `%`/`_`/`\` matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Collapse a >1 identity set deterministically: prefer the one with a LIVE
 * channel; if exactly one is live, that wins. Else the set stays ambiguous (the
 * caller's `jobs` query already ordered newest-by-updated_at first, so a `latest`
 * collapse picks index 0 — but the bus surfaces ambiguity rather than guessing
 * across distinct agents). Returns `{ picked }` for a clean pick, else `{ all }`.
 */
function collapseByLive(
  identities: ResolvedIdentity[],
  channels: LiveChannel[],
):
  | { picked: ResolvedIdentity; channel: LiveChannel }
  | { all: ResolvedIdentity[] } {
  const withLive = identities
    .map((id) => ({ id, channel: liveChannelForIdentity(channels, id) }))
    .filter((x) => x.channel != null) as {
    id: ResolvedIdentity;
    channel: LiveChannel;
  }[];
  if (withLive.length === 1) {
    return { picked: withLive[0].id, channel: withLive[0].channel };
  }
  return { all: identities };
}

/**
 * Resolve a target to a delivery channel and/or stable identity. The full
 * two-layer pipeline:
 *
 *  1. Layer 2 tiers over ALL `jobs` — exact → prefix → substring. First tier
 *     with a single identity (or a single LIVE one among several) wins.
 *  2. Layer 1 maps that identity to its current live channel (may be null — the
 *     agent is known but not on the bus right now).
 *  3. On a keeper MISS, fail-soft to a direct live-channel match (resume gap).
 *  4. Genuine miss → `unknown` (the caller surfaces it; never throws).
 *
 * @param channels  the live in-memory channel set (Layer 1).
 * @param db        read-only keeper.db handle (Layer 2 `jobs` source).
 * @param target    the requested name / id / former name.
 */
export function resolveTarget(
  channels: LiveChannel[],
  db: Database,
  target: string,
): BusResolveResult {
  for (const tier of ["exact", "prefix", "substring"] as const) {
    const identities = jobsAtTier(db, target, tier);
    if (identities.length === 0) continue;
    const method: ResolveMethod =
      tier === "exact"
        ? "jobs-exact"
        : tier === "prefix"
          ? "jobs-prefix"
          : "jobs-substring";
    if (identities.length === 1) {
      return {
        kind: "ok",
        method,
        identity: identities[0],
        channel: liveChannelForIdentity(channels, identities[0]),
      };
    }
    const collapsed = collapseByLive(identities, channels);
    if ("picked" in collapsed) {
      return {
        kind: "ok",
        method,
        identity: collapsed.picked,
        channel: collapsed.channel,
      };
    }
    return { kind: "ambiguous", method, identities: collapsed.all };
  }

  // Keeper miss — fail-soft to the live registry (resume gap: a just-started
  // agent reachable by its register-frame name before keeper folds it).
  const live = matchLiveExact(channels, target);
  if (live.length === 1) {
    return {
      kind: "ok",
      method: "live-fallback",
      identity: null,
      channel: live[0],
    };
  }
  if (live.length > 1) {
    // Ambiguity in the live set alone — surface it (no keeper identity to rank by).
    return {
      kind: "ambiguous",
      method: "live-fallback",
      identities: live.map((c) => ({
        job_id: c.session_id ?? c.channel_id,
        pid: c.pid,
        start_time: c.start_time,
        title: c.current_name,
        name_history: c.name_history,
      })),
    };
  }
  return { kind: "unknown", target };
}
