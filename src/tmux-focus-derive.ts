/**
 * tmux focus derivation — PURE and dependency-free (no `bun:sqlite`, no daemon
 * imports) so it runs in the fast test tier against golden strings.
 *
 * The control-mode worker captures two framed reads over its persistent
 * connection — `list-clients` and `list-panes -a`, each with a tab-delimited
 * `-F` format — and feeds their stdout here. These seams parse that output and
 * derive WHICH session/window/pane the current REAL (non-control) tmux client
 * is focused on, for the live-only `tmux_client_focus` singleton.
 *
 * The worker is responsible for capturing under a locale-defaulted env (see
 * `localeDefaultedEnv` in exec-backend.ts) so a C-locale tmux client does not
 * sanitize the `\t` delimiters to `_`; these seams stay pure and simply parse
 * whatever strings arrive. Mirrors `parsePaneLines` in restore-worker.ts: each
 * field split caps its `\t` count so a session name containing a tab cannot
 * bleed into a numeric field.
 */

/** One `list-clients` row. `controlMode` is `#{client_control_mode}` (1 for
 *  keeper's own observer client, which is dropped). `session` is the attached
 *  session name; an empty session means no attachment. `activity`/`created` are
 *  the tiebreak ordinals; `name` is the lexical final tiebreak. */
export interface TmuxClientRow {
  readonly name: string;
  readonly session: string;
  readonly controlMode: number;
  readonly activity: number;
  readonly created: number;
}

/** One `list-panes -a` row, carrying the active-window / active-pane flags so a
 *  session can be composed down to its focused pane. `windowActive` is
 *  `#{window_active}` (the active window in its session); `paneActive` is
 *  `#{pane_active}` (the active pane in its window). */
export interface TmuxPaneRow {
  readonly session: string;
  readonly windowIndex: number | null;
  readonly windowActive: boolean;
  readonly paneId: string;
  readonly paneActive: boolean;
}

/** The derived focus singleton payload. `focused` carries the resolved
 *  triple; `none` carries no real client / no resolvable active pane. */
export type FocusDerivation =
  | {
      readonly status: "focused";
      readonly session_name: string;
      readonly window_index: number | null;
      readonly pane_id: string;
    }
  | { readonly status: "none" };

/**
 * Expected `list-clients` `-F` format (the worker issues exactly this):
 *   `#{client_name}\t#{client_control_mode}\t#{client_activity}\t#{client_created}\t#{client_session}`
 * The variable-length `client_session` (a user-chosen name) is LAST so a name
 * with embedded tabs cannot bleed into a numeric field — the final slice reads
 * to end-of-line. A malformed row (too few tabs, empty name) is dropped; a
 * non-integer numeric coerces to 0 (it only weakens that row's tiebreak, never
 * throws). Pure; never throws.
 */
export function parseClientLines(text: string): TmuxClientRow[] {
  const rows: TmuxClientRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    // 5 fields → 4 tabs; cap the split so a tabbed session name survives.
    const parts = splitTabs(line, 5);
    if (parts === null) {
      continue;
    }
    const [name, controlRaw, activityRaw, createdRaw, session] = parts;
    if (name === "") {
      continue;
    }
    rows.push({
      name,
      session,
      controlMode: toInt(controlRaw),
      activity: toInt(activityRaw),
      created: toInt(createdRaw),
    });
  }
  return rows;
}

/**
 * Expected `list-panes -a` `-F` format (the worker issues exactly this):
 *   `#{window_active}\t#{pane_active}\t#{window_index}\t#{pane_id}\t#{session_name}`
 * The variable-length `session_name` is LAST so a tabbed name cannot bleed into
 * a numeric/flag field. A malformed row (too few tabs, empty pane_id/session)
 * is dropped; a non-integer `window_index` coerces to `null` (the pane still
 * counts). Pure; never throws.
 */
export function parsePaneLines(text: string): TmuxPaneRow[] {
  const rows: TmuxPaneRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const parts = splitTabs(line, 5);
    if (parts === null) {
      continue;
    }
    const [windowActiveRaw, paneActiveRaw, windowIndexRaw, paneId, session] =
      parts;
    if (paneId === "" || session === "") {
      continue;
    }
    const wi = Number(windowIndexRaw);
    const windowIndex =
      windowIndexRaw !== "" && Number.isInteger(wi) ? wi : null;
    rows.push({
      session,
      windowIndex,
      windowActive: windowActiveRaw === "1",
      paneId,
      paneActive: paneActiveRaw === "1",
    });
  }
  return rows;
}

/**
 * Derive the current focus from parsed client + pane rows. Steps:
 *   1. Drop control-mode clients (`controlMode === 1`) — keeper's own observer.
 *   2. Drop clients with no attached session (empty `session`).
 *   3. Pick the current client: `max(activity)`, tiebreak `max(created)`, then
 *      lexically-LEAST `name`. Deterministic.
 *   4. Compose: current client → its session → that session's ACTIVE window →
 *      that window's ACTIVE pane.
 * Zero real clients (or an unresolvable active pane) → `status: "none"`. Pure;
 * never throws.
 */
export function pickCurrentClient(
  clients: readonly TmuxClientRow[],
  panes: readonly TmuxPaneRow[],
): FocusDerivation {
  const real = clients.filter((c) => c.controlMode !== 1 && c.session !== "");
  if (real.length === 0) {
    return { status: "none" };
  }

  let best = real[0] as TmuxClientRow;
  for (let i = 1; i < real.length; i++) {
    const c = real[i] as TmuxClientRow;
    if (
      c.activity > best.activity ||
      (c.activity === best.activity && c.created > best.created) ||
      (c.activity === best.activity &&
        c.created === best.created &&
        c.name < best.name)
    ) {
      best = c;
    }
  }

  const sessionPanes = panes.filter((p) => p.session === best.session);
  if (sessionPanes.length === 0) {
    return { status: "none" };
  }
  // The session's active window's active pane. Require BOTH the window-active
  // and pane-active flags so a stale/non-focused pane never wins.
  const activePane = sessionPanes.find((p) => p.windowActive && p.paneActive);
  if (activePane === undefined) {
    return { status: "none" };
  }
  return {
    status: "focused",
    session_name: best.session,
    window_index: activePane.windowIndex,
    pane_id: activePane.paneId,
  };
}

/** Split a tab-delimited line into exactly `count` fields, reading the LAST
 *  field to end-of-line (so a trailing variable-length value keeps any embedded
 *  tabs). Returns `null` when there are fewer than `count - 1` tabs. */
function splitTabs(line: string, count: number): string[] | null {
  const out: string[] = [];
  let start = 0;
  for (let f = 0; f < count - 1; f++) {
    const tab = line.indexOf("\t", start);
    if (tab < 0) {
      return null;
    }
    out.push(line.slice(start, tab));
    start = tab + 1;
  }
  out.push(line.slice(start));
  return out;
}

/** Coerce a `-F` numeric field to an integer; a non-integer/empty value becomes
 *  0 (weakens that row's tiebreak ordinal, never throws). */
function toInt(raw: string): number {
  const n = Number(raw);
  return Number.isInteger(n) ? n : 0;
}
