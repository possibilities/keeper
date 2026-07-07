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

/** keeper's own five-rung reasoning-effort vocabulary — the effort axis of the
 *  plan worker `{model × effort}` matrix and the `--effort` flag, ordered
 *  ascending. A harness's {@link HarnessDescriptor.effortAxisMap} translates
 *  these onto its native second-axis bands. */
export const KEEPER_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type KeeperEffort = (typeof KEEPER_EFFORTS)[number];

/** How a harness's live working/stopped churn reaches keeper's jobs projection.
 *  `claude-hooks`: keeper's native hook set feeds the events-log channel.
 *  `pi-extension`: an ephemeral in-process pi extension (armed per-launch via
 *  `-e`) translates pi's AgentHarness events into the same events-log channel.
 *  `codex-rollout-tail`: the daemon-side producer forward-tails the attributed
 *  rollout and mints a synthetic Stop per turn-completion — STOP-ONLY, since
 *  codex's rollout carries no turn-START marker (degrades to presence-only when a
 *  rollout is unattributed or absent).
 *  `none`: no live hook channel — presence-only (hermes today). */
export type HookMechanism =
  | "claude-hooks"
  | "pi-extension"
  | "codex-rollout-tail"
  | "none";

/**
 * How a harness's resume target is passed on its OWN native CLI argv.
 *  - `flag`: an `<token> <target>` OPTION pair that may follow other flags —
 *    claude `--resume <uuid>`, pi `--session <id>`, hermes `--resume <id>`.
 *  - `subcommand`: a VERB-POSITION `<token> <target>` that must LEAD the
 *    forwarded harness argv — codex `resume <uuid>`. The launcher strips its own
 *    `--x-*` flags before forwarding, so a subcommand token still lands first
 *    among the harness-visible args.
 * `token` is the literal first element (`--resume` / `--session` / `resume`).
 */
export interface ResumeArgvForm {
  kind: "flag" | "subcommand";
  token: string;
}

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
  /** Translation of keeper's five efforts onto this harness's native second-axis
   *  bands, or `null` when they pass through unmapped (claude's `--effort` is
   *  native; hermes has no second axis). Total over {@link KEEPER_EFFORTS}; a
   *  token that is not a keeper effort (an already-native band) is left as-is by
   *  {@link mapKeeperEffortToAxis}. */
  effortAxisMap: Record<KeeperEffort, string> | null;
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
  /** How this harness's resume target is spelled on its native CLI (the verb
   *  or option token keeper emits after `keeper agent <name>` to re-attach). */
  resumeArgv: ResumeArgvForm;
}

/** codex and pi expose the same reasoning-band vocabulary
 *  (minimal/low/medium/high/xhigh), so keeper's efforts map onto it identically:
 *  identity for the four shared rungs, with keeper's top `max` capped at the
 *  shared `xhigh` band. */
const KEEPER_EFFORT_TO_REASONING_BAND: Record<KeeperEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

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
    // Claude's native `--effort` speaks keeper's efforts directly — no translation.
    effortAxisMap: null,
    capturable: true,
    mintsOwnSessionId: false,
    hookMechanism: "claude-hooks",
    resumeArgv: { kind: "flag", token: "--resume" },
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    binaryName: "codex",
    profileEnvVar: "KEEPER_AGENT_CODEX_PROFILE",
    secondAxis: "effort",
    effortAxisMap: KEEPER_EFFORT_TO_REASONING_BAND,
    capturable: true,
    mintsOwnSessionId: true,
    // M3b: live stop-churn via the daemon-side rollout tailer. Stop-only — codex's
    // rollout has no turn-START marker — and degrades to presence-only when the
    // session is unattributed.
    hookMechanism: "codex-rollout-tail",
    // Codex resumes via a VERB-POSITION subcommand (`codex resume <uuid>`), not an
    // option flag — the argv builder must lead the forwarded args with it.
    resumeArgv: { kind: "subcommand", token: "resume" },
  },
  pi: {
    name: "pi",
    displayName: "Pi",
    binaryName: "pi",
    profileEnvVar: "KEEPER_AGENT_PI_PROFILE",
    secondAxis: "thinking",
    effortAxisMap: KEEPER_EFFORT_TO_REASONING_BAND,
    capturable: true,
    mintsOwnSessionId: false,
    // M3b: an ephemeral in-process extension (plugins/keeper/pi-extension,
    // armed per-launch via `-e`) mirrors pi's AgentHarness lifecycle into the
    // events-log channel, so pi shows the same working/stopped churn as claude.
    hookMechanism: "pi-extension",
    // Pi pins its session id at launch and resumes by it via `pi --session <id>`.
    resumeArgv: { kind: "flag", token: "--session" },
  },
  hermes: {
    name: "hermes",
    displayName: "Hermes",
    binaryName: "hermes",
    profileEnvVar: "KEEPER_AGENT_HERMES_PROFILE",
    // Hermes is model-only: it exposes neither an effort nor a thinking axis, so
    // a preset for it may set neither (config.ts fails a preset that does).
    secondAxis: "none",
    // Model-only: no second axis, so keeper efforts never reach a hermes argv.
    effortAxisMap: null,
    // M2: captured by bounded polling of `hermes sessions export`, positively
    // attributed by cwd + created-at (refuse-to-guess on collision). Capturable
    // ⇒ panel-eligible with no extra panel wiring.
    capturable: true,
    // Hermes mints its own session id keeper cannot pin at launch; the resume
    // target is its native session id, discovered post-stop from the store.
    mintsOwnSessionId: true,
    hookMechanism: "none",
    // Hermes resumes by native session id: `hermes --resume <id>` (option flag,
    // MEDIUM confidence — verified against `src/agent/args.ts`'s hermes predicate).
    resumeArgv: { kind: "flag", token: "--resume" },
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

/**
 * Translate a keeper effort onto `harness`'s native second-axis band via its
 * descriptor {@link HarnessDescriptor.effortAxisMap}. A null map (claude effort
 * is native, hermes has none) returns the token unchanged, so those argvs stay
 * byte-identical. A token outside {@link KEEPER_EFFORTS} — an already-native band
 * such as codex/pi `minimal` — also passes through untouched, so the map rewrites
 * only genuine keeper efforts (in practice just `max` → `xhigh` for codex/pi).
 */
export function mapKeeperEffortToAxis(
  harness: HarnessName,
  effort: string,
): string {
  const map = HARNESS_DESCRIPTORS[harness].effortAxisMap;
  if (map === null) {
    return effort;
  }
  return map[effort as KeeperEffort] ?? effort;
}

/** True when a harness's final message is capturable (M2) — the panel-eligibility
 *  capability. An unknown name is not capturable. */
export function isCapturableHarness(name: string): boolean {
  return harnessDescriptor(name)?.capturable ?? false;
}

/**
 * The harness a `jobs` row belongs to, defaulting a NULL/empty/unknown tag to
 * `"claude"`. NULL harness reads as claude at every consumer (the SessionStart
 * fold never synthesizes a value), so this is the single normalization point the
 * resume/restore surfaces resolve a stored `jobs.harness` through.
 */
export function harnessOrClaude(name: string | null | undefined): HarnessName {
  const n = (name ?? "").trim();
  return isHarnessName(n) ? n : "claude";
}

/**
 * The per-harness resume argv tokens for a target — the verb-position or
 * option-flag pair the harness's own CLI re-attaches with (`--resume <t>` /
 * `resume <t>` / `--session <t>`). Both forms yield `[token, target]`; the
 * descriptor's {@link ResumeArgvForm.kind} documents WHY codex's token carries no
 * dashes (a subcommand, not an option) and is asserted by the builder's tests. An
 * unknown harness falls back to claude's `--resume` form. Pure.
 */
export function buildHarnessResumeArgv(
  name: string | null | undefined,
  target: string,
): string[] {
  const d = HARNESS_DESCRIPTORS[harnessOrClaude(name)];
  return [d.resumeArgv.token, target];
}
