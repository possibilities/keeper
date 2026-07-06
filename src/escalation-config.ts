/**
 * Escalation-session launch-config resolver — the twin of
 * `resolveWorkerLaunchConfig` (`src/autopilot-worker.ts`) for the two autonomous
 * escalation dispatches (`unblock::<task>`, `deconflict::<epic>`). Coalesces an
 * `escalation` preset from `presets.yaml` over the `ESCALATION_*` constants,
 * DELIBERATELY independent of the `worker` preset so the escalation model/effort
 * never tracks the worker cell's.
 *
 * Its own leaf so the daemon's escalation-dispatch path AND the manual `keeper
 * dispatch` CLI both import it WITHOUT dragging the autopilot worker module
 * (`./db` + `./server-worker`) onto their graphs. Its only value edges are the
 * dep-free config island (`./agent/config`) and the `ESCALATION_*` constants
 * (`./reconcile-core`); it never reaches the DB or an exec driver.
 */

import { ConfigError, loadPresetCatalog, type Preset } from "./agent/config";
import { ESCALATION_EFFORT, ESCALATION_MODEL } from "./reconcile-core";

/**
 * Distinct non-claude `escalation`-preset harness values already warned about, so
 * {@link resolveEscalationLaunchConfig} logs the drop ONCE per offending value
 * rather than on every dispatch. Producer-side process memo (never a fold input);
 * tests inject a fresh set to observe the once-per-value contract.
 */
const droppedEscalationHarnessWarned = new Set<string>();

/**
 * Resolve the escalation session's `{model, effort}` — the `escalation` preset in
 * `presets.yaml` (when present) layered per-field over the `ESCALATION_*`
 * constants, exactly mirroring {@link
 * import("./autopilot-worker").resolveWorkerLaunchConfig} but reading a SEPARATE
 * preset key. A missing OR malformed catalog is SWALLOWED-to-constants (never a
 * throw — an escalation dispatch must not crash on bad config). A non-claude
 * `preset.harness` is IGNORED (escalation dispatch is claude-only until harness
 * dispatch lands) but WARNED once per distinct offending value via `warned`.
 * Re-resolved per dispatch (cheap single-file parse); never file-watched.
 */
export function resolveEscalationLaunchConfig(
  configPath?: string,
  warned: Set<string> = droppedEscalationHarnessWarned,
): {
  model: string;
  effort: string;
} {
  let preset: Preset | undefined;
  try {
    const catalog = loadPresetCatalog(
      ...(configPath === undefined ? [] : ([configPath] as const)),
    );
    preset = catalog.presets.escalation;
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
    preset !== undefined &&
    preset.harness !== "claude" &&
    !warned.has(preset.harness)
  ) {
    warned.add(preset.harness);
    console.error(
      `[escalation-config] escalation preset pins harness '${preset.harness}', but ` +
        `escalation dispatch ignores non-claude harness values until harness ` +
        `dispatch lands — launching on claude.`,
    );
  }
  return {
    model: preset?.model ?? ESCALATION_MODEL,
    effort: preset?.effort ?? ESCALATION_EFFORT,
  };
}
