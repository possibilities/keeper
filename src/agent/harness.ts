/**
 * Per-harness descriptor registry — the single source of truth for which agent
 * harnesses `keeper agent` drives and how each one behaves. Every parallel
 * harness union (`AgentKind`, `AgentCli`, `PresetHarness`) and its runtime name
 * set (`AGENT_CLIS`, `PRESET_HARNESSES`, the run-capture agent set) is DERIVED
 * from {@link HARNESS_DESCRIPTORS} here, so a harness name lives in exactly one
 * place. Downstream gates read a capability flag, NEVER a harness-name allowlist:
 * panel eligibility is `capturable`, not a `claude|codex` literal.
 *
 * DEP-FREE ISLAND: this module imports NOTHING. It sits at the bottom of the
 * launch-config / config / dispatch / run-capture cluster (they import it; it
 * imports none of them), so it can never form an import cycle nor drag a heavier
 * dependency onto the cold-start `keeper agent` path. Pure data only — a harness
 * is a row of facts here, not a branch scattered across forty edit sites.
 */

/** The canonical, ordered set of harness names keeper drives. The one literal
 *  list — every union's membership check derives from it. */
export const HARNESS_NAMES = ["claude", "codex", "pi", "hermes"] as const;

/** A harness keeper can drive — the derivation root for `AgentKind`/`AgentCli`/
 *  `PresetHarness`. */
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** The second reasoning axis a harness exposes. claude/codex take `effort`; pi
 *  takes `thinking`; the two are mutually exclusive per harness. `none` means the
 *  harness is model-only (hermes) — a preset for it may set neither axis. */
export type SecondAxis = "effort" | "thinking" | "none";

/** How a harness's live working/stopped churn reaches keeper's jobs projection.
 *  `claude-hooks`: keeper's native hook set feeds the events-log channel.
 *  `pi-extension`: an ephemeral in-process pi extension (armed per-launch via
 *  `-e`) translates pi's AgentHarness events into the same events-log channel.
 *  `none`: no live hook channel — presence-only (codex today). */
export type HookMechanism = "claude-hooks" | "pi-extension" | "none";

/** One harness's full behavioral row: identity, launch, second axis, and the
 *  capability flags that gate downstream behavior. */
export interface HarnessDescriptor {
  /** The canonical name (also the `keeper agent <name>` positional). */
  name: HarnessName;
  /** Title-case label for human-facing output. */
  displayName: string;
  /** The executable resolved on PATH for this harness. */
  binaryName: string;
  /** The env var naming this harness's resolved launch profile. */
  profileEnvVar: string;
  /** The second reasoning axis this harness accepts (effort|thinking|none). */
  secondAxis: SecondAxis;
  /** M2 capability: `keeper agent run` / a panel leg can capture this harness's
   *  final message (transcript discovery + stop parser exist). GATES panel
   *  eligibility — a non-capturable harness is a launchable partner but not a
   *  panel member. */
  capturable: boolean;
  /** True when the harness mints its OWN session id keeper cannot pin at launch
   *  (codex/hermes): the resume target is discovered post-stop by positive
   *  attribution (codex from its rollout file, hermes from its session store).
   *  False when keeper pins the session id at launch (claude/pi), so it is
   *  authoritative immediately. */
  mintsOwnSessionId: boolean;
  /** How this harness's live churn reaches the jobs projection. */
  hookMechanism: HookMechanism;
}

/** The registry — one {@link HarnessDescriptor} per {@link HarnessName}. The
 *  single home for per-harness facts; add a harness by adding a row here (plus
 *  its native builders / parsers in the consuming modules), never by threading a
 *  new name literal through the parallel unions. */
export const HARNESS_DESCRIPTORS: Record<HarnessName, HarnessDescriptor> = {
  claude: {
    name: "claude",
    displayName: "Claude",
    binaryName: "claude",
    profileEnvVar: "KEEPER_AGENT_CLAUDE_PROFILE",
    secondAxis: "effort",
    capturable: true,
    mintsOwnSessionId: false,
    hookMechanism: "claude-hooks",
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    binaryName: "codex",
    profileEnvVar: "KEEPER_AGENT_CODEX_PROFILE",
    secondAxis: "effort",
    capturable: true,
    mintsOwnSessionId: true,
    hookMechanism: "none",
  },
  pi: {
    name: "pi",
    displayName: "Pi",
    binaryName: "pi",
    profileEnvVar: "KEEPER_AGENT_PI_PROFILE",
    secondAxis: "thinking",
    capturable: true,
    mintsOwnSessionId: false,
    // M3b: an ephemeral in-process extension (plugins/keeper/pi-extension,
    // armed per-launch via `-e`) mirrors pi's AgentHarness lifecycle into the
    // events-log channel, so pi shows the same working/stopped churn as claude.
    hookMechanism: "pi-extension",
  },
  hermes: {
    name: "hermes",
    displayName: "Hermes",
    binaryName: "hermes",
    profileEnvVar: "KEEPER_AGENT_HERMES_PROFILE",
    // Hermes is model-only: it exposes neither an effort nor a thinking axis, so
    // a preset for it may set neither (config.ts fails a preset that does).
    secondAxis: "none",
    // M2: captured by bounded polling of `hermes sessions export`, positively
    // attributed by cwd + created-at (refuse-to-guess on collision). Capturable
    // ⇒ panel-eligible with no extra panel wiring.
    capturable: true,
    // Hermes mints its own session id keeper cannot pin at launch; the resume
    // target is its native session id, discovered post-stop from the store.
    mintsOwnSessionId: true,
    hookMechanism: "none",
  },
};

/** The set of all known harness names — the runtime membership root every
 *  parallel union's validator delegates to. */
export const HARNESS_NAME_SET: ReadonlySet<string> = new Set(HARNESS_NAMES);

/** True when `name` is a known harness. The single membership predicate — an
 *  unknown harness name fails this check, which is how presets/panel config fail
 *  loud at load. */
export function isHarnessName(name: string): name is HarnessName {
  return HARNESS_NAME_SET.has(name);
}

/** The descriptor for a known harness, or undefined for an unknown name. */
export function harnessDescriptor(name: string): HarnessDescriptor | undefined {
  return isHarnessName(name) ? HARNESS_DESCRIPTORS[name] : undefined;
}

/** True when a harness's final message is capturable (M2) — the panel-eligibility
 *  capability. An unknown name is not capturable. */
export function isCapturableHarness(name: string): boolean {
  return harnessDescriptor(name)?.capturable ?? false;
}
