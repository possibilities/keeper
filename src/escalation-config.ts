/**
 * Escalation-session launch-config resolver — the twin of
 * `resolveWorkerLaunchConfig` (`src/autopilot-worker.ts`) for the two autonomous
 * escalation dispatches (`unblock::<task>`, `deconflict::<epic>`). Coalesces the
 * `escalation` launch triple from `presets.yaml` over the `ESCALATION_*` constants,
 * DELIBERATELY independent of the `worker` triple so the escalation model/effort
 * never tracks the worker cell's.
 *
 * Its own leaf so the daemon's escalation-dispatch path AND the manual `keeper
 * dispatch` CLI both import it WITHOUT dragging the autopilot worker module
 * (`./db` + `./server-worker`) onto their graphs. Its only value edges are the
 * dep-free config island (`./agent/config`) and the `ESCALATION_*` constants
 * (`./reconcile-core`); it never reaches the DB or an exec driver.
 */

import { ConfigError, loadPresetCatalog } from "./agent/config";
import type { Triple } from "./agent/triple";
import { ESCALATION_EFFORT, ESCALATION_MODEL } from "./reconcile-core";

/**
 * Distinct non-claude `escalation`-triple harness values already warned about, so
 * {@link resolveEscalationLaunchConfig} logs the drop ONCE per offending value
 * rather than on every dispatch. Producer-side process memo (never a fold input);
 * tests inject a fresh set to observe the once-per-value contract.
 */
const droppedEscalationHarnessWarned = new Set<string>();

/**
 * Resolve the escalation session's `{model, effort}` — the `escalation` launch
 * triple in `presets.yaml` (when present) over the `ESCALATION_*` constants,
 * exactly mirroring {@link
 * import("./autopilot-worker").resolveWorkerLaunchConfig} but reading a SEPARATE
 * key. A missing OR malformed catalog (including a malformed `escalation` triple)
 * is SWALLOWED-to-constants (never a throw — an escalation dispatch must not crash
 * on bad config). A non-claude triple harness is IGNORED (escalation dispatch is
 * claude-only until harness dispatch lands) but WARNED once per distinct offending
 * value via `warned`; its model/effort still resolve so the launch proceeds on
 * claude with the configured knobs. Re-resolved per dispatch (cheap single-file
 * parse); never file-watched.
 */
export function resolveEscalationLaunchConfig(
  configPath?: string,
  warned: Set<string> = droppedEscalationHarnessWarned,
): {
  model: string;
  effort: string;
} {
  let triple: Triple | null | undefined;
  try {
    const catalog = loadPresetCatalog(
      ...(configPath === undefined ? [] : ([configPath] as const)),
    );
    triple = catalog.escalation;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        "[escalation-config] preset catalog missing or invalid — using escalation defaults:",
        err.message,
      );
    } else {
      throw err;
    }
  }
  if (
    triple !== undefined &&
    triple !== null &&
    triple.harness !== "claude" &&
    !warned.has(triple.harness)
  ) {
    warned.add(triple.harness);
    console.error(
      `[escalation-config] escalation triple pins harness '${triple.harness}', but ` +
        `escalation dispatch ignores non-claude harness values until harness ` +
        `dispatch lands — launching on claude.`,
    );
  }
  return {
    model: triple?.model ?? ESCALATION_MODEL,
    effort: triple?.effort ?? ESCALATION_EFFORT,
  };
}
