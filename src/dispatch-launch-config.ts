/**
 * Dispatch-table launch-config resolver (ADR 0040) — resolves each dispatched
 * verb's `{harness?, model?, effort?}` from the `dispatch:` table in
 * `presets.yaml`, floored to the compiled-in `WORKER_*`/`ESCALATION_*`
 * constants when a row is absent, unset, or the catalog fails to parse.
 * Mirrors `resolveWorkerLaunchConfig` (`src/autopilot-worker.ts`) and
 * `resolveEscalationLaunchConfig` (`src/escalation-config.ts`) — its own leaf
 * so the daemon's dispatch surface AND the manual `keeper dispatch` CLI both
 * import it without dragging the autopilot worker module (`./db` +
 * `./server-worker`) onto their graphs. Its only value edges are the dep-free
 * config island (`./agent/config`) and the `WORKER_*`/`ESCALATION_*` floor
 * constants (`./reconcile-core`); it never reaches the DB or an exec driver.
 *
 * This task (ADR 0040 task 1) is ADDITIVE: the catalog still parses the
 * retired `worker`/`escalation` keys unchanged, and this module is not yet
 * wired into any consumer — task 2 performs the cutover.
 */

import {
  ConfigError,
  type DispatchVerb,
  loadPresetCatalog,
} from "./agent/config";
import type { Triple } from "./agent/triple";
import {
  ESCALATION_EFFORT,
  ESCALATION_MODEL,
  WORKER_EFFORT,
  WORKER_MODEL,
} from "./reconcile-core";

export type { DispatchVerb };

/**
 * The resolved launch posture for one dispatched verb — the ONE shared return
 * shape every dispatch-table consumer reads (task 2's daemon/CLI callers
 * included), so it stays byte-identical across call sites. Every field is
 * optional: absent means "no override", the caller's own default applies.
 * `harness` rides through UNVALIDATED (this resolver never enforces
 * claude-only; that posture belongs to each caller, mirroring the
 * worker/escalation twins) — a non-claude triple still resolves its
 * model/effort here, warned once via {@link resolveDispatchLaunchConfig}.
 */
export interface DispatchLaunchConfig {
  harness?: string;
  model?: string;
  effort?: string;
}

/**
 * The compiled-in floor `{model, effort}` per dispatch verb class (ADR 0040,
 * human-confirmed): `work`/`close`/`resolve` floor to the `WORKER_*`
 * constants (the reconcile-core work/close pair); `unblock`/`deconflict`/
 * `repair` floor to the `ESCALATION_*` constants (today's autonomous-
 * escalation defaults); `handoff` floors to fully-absent (no flags → the
 * harness's own default — handoff carries no compiled default today).
 * `Record<DispatchVerb, ...>` types this exhaustively so a new verb cannot
 * ship unmapped without a compile error (compile-time totality).
 */
const DISPATCH_FLOORS: Record<DispatchVerb, DispatchLaunchConfig> = {
  work: { model: WORKER_MODEL, effort: WORKER_EFFORT },
  close: { model: WORKER_MODEL, effort: WORKER_EFFORT },
  resolve: { model: WORKER_MODEL, effort: WORKER_EFFORT },
  unblock: { model: ESCALATION_MODEL, effort: ESCALATION_EFFORT },
  deconflict: { model: ESCALATION_MODEL, effort: ESCALATION_EFFORT },
  repair: { model: ESCALATION_MODEL, effort: ESCALATION_EFFORT },
  handoff: {},
};

/**
 * Distinct `verb::harness` pairs already warned about for a non-claude
 * dispatch triple, so {@link resolveDispatchLaunchConfig} logs the drop ONCE
 * per pair rather than on every dispatch. Producer-side process memo (never a
 * fold input); tests inject a fresh set to observe the once-per-pair
 * contract.
 */
const droppedDispatchHarnessWarned = new Set<string>();

/**
 * Resolve one dispatched verb's launch config from the `dispatch:` table in
 * `presets.yaml` (ADR 0040). `approve` resolves identically to `work` — it
 * shares the `work` row; there is no separate `approve` key in the table.
 *
 * Fail-SAFE like the worker/escalation twins: ANY parse failure — a missing
 * file, malformed YAML, an unknown top-level/dispatch-verb key, or a
 * malformed triple ANYWHERE in the catalog (not just the dispatch block) —
 * floors EVERY verb to its compiled-in constants ({@link DISPATCH_FLOORS}):
 * whole-file-to-floor, no per-verb salvage (human-confirmed, ADR 0040). A
 * missing file and a malformed one are logged with distinct wording; an
 * absent row in an otherwise-valid catalog floors silently (the expected,
 * unremarkable case — matching the worker/escalation twins' posture).
 *
 * A non-claude triple harness WARNS once per (verb, harness) via `warned` but
 * still resolves the configured model/effort — dispatch is claude-only until
 * harness dispatch lands, so today's callers should ignore the returned
 * `harness` field; it rides through so a future harness-aware caller need not
 * re-parse the table.
 *
 * Re-resolved per call (cheap single-file parse); never file-watched.
 */
export function resolveDispatchLaunchConfig(
  verb: DispatchVerb | "approve",
  configPath?: string,
  warned: Set<string> = droppedDispatchHarnessWarned,
): DispatchLaunchConfig {
  const row: DispatchVerb = verb === "approve" ? "work" : verb;
  const floor = DISPATCH_FLOORS[row];
  let triple: Triple | null;
  try {
    const catalog = loadPresetCatalog(
      ...(configPath === undefined ? [] : ([configPath] as const)),
    );
    triple = catalog.dispatch?.[row] ?? null;
  } catch (err) {
    if (err instanceof ConfigError) {
      const reason = /missing at/.test(err.message) ? "missing" : "malformed";
      console.error(
        `[dispatch-launch-config] preset catalog ${reason} — using dispatch floor for '${row}':`,
        err.message,
      );
      return { ...floor };
    }
    throw err;
  }
  if (triple === null) {
    return { ...floor };
  }
  const warnKey = `${row}::${triple.harness}`;
  if (triple.harness !== "claude" && !warned.has(warnKey)) {
    warned.add(warnKey);
    console.error(
      `[dispatch-launch-config] dispatch.${row} triple pins harness '${triple.harness}', but ` +
        "dispatch ignores non-claude harness values until harness dispatch " +
        "lands — launching on claude.",
    );
  }
  return {
    harness: triple.harness,
    model: triple.model,
    effort: triple.effort,
  };
}
