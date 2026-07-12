/**
 * Launch triples — the context-free `<harness>::<model>::<effort>` launch token
 * that names a launchable cell independent of any host config (ADR 0033). The
 * grammar is validate-by-construction: exactly three `::`-separated segments, so a
 * bare `:` inside a segment is unparseable (the model/effort charsets exclude it);
 * the harness segment is a registered harness, the model segment a slash-joined
 * matrix alias-target token, and the effort segment a canonical keeper effort — or
 * the `na` sentinel, REQUIRED for an axisless harness (hermes) and forbidden for
 * one that carries a second reasoning axis. Every rejection names the offending
 * segment.
 *
 * The raw triple is the identity everywhere; {@link slugifyTriple} derives a
 * display/file form (tmux/window/file names) via the shared slug primitive, with a
 * short stable hash suffix available to disambiguate the non-injective slug.
 *
 * {@link enumerateTriples} fans the host matrix into the virtual launch cube every
 * provider — routed OR launch-only — contributes; {@link lintHostTriples} checks
 * the operator's configured triples against that cube (the `providers check`
 * doctor).
 *
 * DEP-FREE ISLAND: imports only the sibling launcher-config islands (`./harness`,
 * `./matrix`) + `../slug` — never `src/db.ts` (bun:sqlite). Pure; no fs, no env.
 */

import { SLUG_MAX_LEN, slugify } from "../slug";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_NAMES,
  type HarnessName,
  isHarnessName,
  KEEPER_EFFORTS,
} from "./harness";
import {
  effortsFor,
  isValidMatrixAliasTarget,
  type Matrix,
  type MatrixV2,
  matrixV2EffortsFor,
} from "./matrix";

/** The `na` effort sentinel an axisless harness (hermes) carries in its triple —
 *  it exposes no second reasoning axis, so no keeper effort applies. */
export const TRIPLE_EFFORT_NA = "na";

/** The `::` segment delimiter — the ONLY colon site in a well-formed triple, which
 *  is exactly why a bare `:` inside a segment is unparseable by construction. */
export const TRIPLE_DELIM = "::";

/** Max chars per triple segment. A triple rides as a launch token and slugifies
 *  onto tmux/window/file names, so each segment stays bounded. */
export const TRIPLE_SEGMENT_MAX_LEN = 64;

/** A parsed launch triple. The three segments are the identity; a display slug is
 *  a lossy derivation, never round-tripped back to a triple. */
export interface Triple {
  harness: HarnessName;
  model: string;
  effort: string;
}

/** Discriminated result of {@link parseTriple} — a rejection carries a message
 *  naming the offending segment (never a best-effort partial parse). */
export type ParseTripleResult =
  | { ok: true; triple: Triple }
  | { ok: false; error: string };

/**
 * Parse `<harness>::<model>::<effort>` into a {@link Triple}, or a rejection whose
 * message names the offending segment. Validate-by-construction: exactly three
 * `::`-separated segments (so a 2- or 4-segment string and a bare colon inside any
 * segment both reject), a registered harness, a slash-joined alias-target model
 * token, and an effort honoring the na-for-axisless rule — `na` REQUIRED for an
 * axisless harness (hermes) and forbidden for one with a second axis, where the
 * effort must be a canonical keeper effort. Every segment is length-bounded. Pure.
 */
export function parseTriple(raw: string): ParseTripleResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      error: "empty launch triple (expected harness::model::effort)",
    };
  }
  const segments = raw.split(TRIPLE_DELIM);
  if (segments.length !== 3) {
    return {
      ok: false,
      error: `launch triple '${raw}' must have exactly three '::'-separated segments (harness::model::effort), got ${segments.length}`,
    };
  }
  const [harness, model, effort] = segments as [string, string, string];
  for (const [label, seg] of [
    ["harness", harness],
    ["model", model],
    ["effort", effort],
  ] as const) {
    if (seg.length > TRIPLE_SEGMENT_MAX_LEN) {
      return {
        ok: false,
        error: `launch triple ${label} segment '${seg}' exceeds the ${TRIPLE_SEGMENT_MAX_LEN}-char cap`,
      };
    }
  }
  if (!isHarnessName(harness)) {
    return {
      ok: false,
      error: `launch triple harness segment '${harness}' is not a registered harness (expected one of ${HARNESS_NAMES.join("|")})`,
    };
  }
  if (!isValidMatrixAliasTarget(model)) {
    return {
      ok: false,
      error: `launch triple model segment '${model}' must be '/'-joined [a-z0-9._-] tokens (no leading dot, no empty segment, no bare colon)`,
    };
  }
  const axisless = HARNESS_DESCRIPTORS[harness].secondAxis === "none";
  if (axisless) {
    if (effort !== TRIPLE_EFFORT_NA) {
      return {
        ok: false,
        error: `launch triple effort segment '${effort}' must be '${TRIPLE_EFFORT_NA}' for the axisless harness '${harness}'`,
      };
    }
  } else if (effort === TRIPLE_EFFORT_NA) {
    return {
      ok: false,
      error: `launch triple effort segment '${TRIPLE_EFFORT_NA}' is forbidden for '${harness}', which carries a second axis (expected one of ${KEEPER_EFFORTS.join("|")})`,
    };
  } else if (!(KEEPER_EFFORTS as readonly string[]).includes(effort)) {
    return {
      ok: false,
      error: `launch triple effort segment '${effort}' is not a canonical effort (expected one of ${KEEPER_EFFORTS.join("|")})`,
    };
  }
  return { ok: true, triple: { harness, model, effort } };
}

/** Serialize a {@link Triple} back to its canonical `harness::model::effort`
 *  string — the identity form. */
export function formatTriple(t: Triple): string {
  return `${t.harness}${TRIPLE_DELIM}${t.model}${TRIPLE_DELIM}${t.effort}`;
}

/**
 * A short stable hash of a triple's identity — a deterministic FNV-1a/32 over the
 * canonical string, base36-encoded. Used ONLY to disambiguate a non-injective
 * slug; never an identity (route + dedupe on the raw triple). Pure.
 */
export function tripleHash(t: Triple): string {
  const s = formatTriple(t);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/**
 * The display/file slug for a triple (tmux/window/file names) via the shared
 * {@link slugify} primitive — lossy and non-injective, so the raw triple stays the
 * identity everywhere. With `disambiguate`, a short stable {@link tripleHash}
 * suffix is appended (and the head truncated to stay within {@link SLUG_MAX_LEN}),
 * so two triples that slugify identically still land on distinct names. Pure.
 */
export function slugifyTriple(
  t: Triple,
  opts?: { disambiguate?: boolean },
): string {
  const base = slugify(formatTriple(t)) ?? tripleHash(t);
  if (!opts?.disambiguate) {
    return base;
  }
  const suffix = tripleHash(t);
  const room = SLUG_MAX_LEN - suffix.length - 1;
  const head =
    base.length > room
      ? base.slice(0, Math.max(1, room)).replace(/-+$/g, "")
      : base;
  return `${head}-${suffix}`;
}

/** One enumerated cell of the virtual launch cube: the launch triple plus the
 *  capability token and native id it derives from, and the effort rung. */
export interface EnumeratedTriple {
  /** The canonical `harness::native_id::effort` launch token. */
  triple: string;
  /** The keeper capability token the provider serves. */
  capability: string;
  /** The provider-native id (alias target, or the capability when unaliased) — the
   *  model segment of {@link EnumeratedTriple.triple}. */
  native_id: string;
  /** A canonical keeper effort, or `na` for an axisless harness (hermes). */
  effort: string;
}

/** One harness's slice of the virtual cube: every triple its matrix provider
 *  fans out, tagged with whether the provider routes (launch-only when false). */
export interface HarnessCube {
  harness: HarnessName;
  /** `false` = a launch-only provider (route: false): enumerable for launch, but
   *  absent from the wrapped-cell pecking order and the capability cell set. */
  route: boolean;
  triples: EnumeratedTriple[];
}

/**
 * Enumerate the virtual launch cube from the host matrix: every provider — routed
 * OR launch-only — fans its models (by native id) over its effective effort list
 * ({@link effortsFor}, the model → provider → top-level clobber chain), except an
 * axisless harness (hermes) which emits a single `na` triple per model. The order
 * is provider declaration order, then model declaration order, then canonical
 * ascending efforts. Pure over the matrix.
 */
export function enumerateTriples(matrix: Matrix): HarnessCube[] {
  const cube: HarnessCube[] = [];
  for (const provider of matrix.providers) {
    const axisless = HARNESS_DESCRIPTORS[provider.name].secondAxis === "none";
    const triples: EnumeratedTriple[] = [];
    for (const [capability, nativeId] of provider.models) {
      const efforts = axisless
        ? [TRIPLE_EFFORT_NA]
        : effortsFor(matrix, capability);
      for (const effort of efforts) {
        triples.push({
          triple: formatTriple({
            harness: provider.name,
            model: nativeId,
            effort,
          }),
          capability,
          native_id: nativeId,
          effort,
        });
      }
    }
    cube.push({ harness: provider.name, route: provider.route, triples });
  }
  return cube;
}

/** The set of every enumerable triple string in the cube — the membership oracle
 *  the doctor lints host triples against. */
export function enumerateTripleStrings(matrix: Matrix): Set<string> {
  const set = new Set<string>();
  for (const group of enumerateTriples(matrix)) {
    for (const t of group.triples) {
      set.add(t.triple);
    }
  }
  return set;
}

// ── host-triple lint (providers check doctor) ────────────────────────────────

/** One operator-configured launch triple to lint, labeled by where it was read
 *  (`claude_default`, `worker`, `panel 'reviewers' member 2`, …). */
export interface HostTripleRef {
  source: string;
  raw: string;
}

/** One `providers check` host-triple finding. A malformed triple is a tool FAULT
 *  (the operator wrote a triple the grammar rejects); a well-formed triple absent
 *  from the enumerable cube is DRIFT (a launch reference nothing serves). */
export type HostTripleFinding =
  | { kind: "malformed-triple"; source: string; triple: string; error: string }
  | { kind: "off-cube-triple"; source: string; triple: string };

/**
 * Lint the operator's configured launch triples against the enumerable cube. Each
 * ref parses: a rejection is a `malformed-triple` fault carrying the grammar
 * error; a well-formed triple whose canonical form is absent from the cube is
 * `off-cube-triple` drift. Pure over (matrix, refs).
 */
export function lintHostTriples(
  matrix: Matrix,
  refs: readonly HostTripleRef[],
): HostTripleFinding[] {
  const cube = enumerateTripleStrings(matrix);
  const findings: HostTripleFinding[] = [];
  for (const ref of refs) {
    const parsed = parseTriple(ref.raw);
    if (!parsed.ok) {
      findings.push({
        kind: "malformed-triple",
        source: ref.source,
        triple: ref.raw,
        error: parsed.error,
      });
      continue;
    }
    const canonical = formatTriple(parsed.triple);
    if (!cube.has(canonical)) {
      findings.push({
        kind: "off-cube-triple",
        source: ref.source,
        triple: canonical,
      });
    }
  }
  return findings;
}

// ── v2 cube enumeration (operator diagnostic verbs) ──────────────────────────
//
// The v2 counterpart of {@link enumerateTriples}/{@link lintHostTriples},
// feeding `presets list`/`providers check` (main.ts) from a v2 {@link
// MatrixV2}. v2 retires the per-PROVIDER `route:` flag — launch-only is a
// per-CAPABILITY fact (absence from `subagent_models`, ADR 0036) — so each
// triple carries its own `cell` membership rather than one flag per harness.

/** One enumerated v2 cube cell: the launch triple plus the capability token,
 *  the provider-native launch id it derives from, the effort rung, and whether
 *  the capability is a worker cell (`subagent_models` membership) — false means
 *  launch-only: enumerable here, but never in the cell set. */
export interface EnumeratedTripleV2 {
  triple: string;
  capability: string;
  launch_id: string;
  effort: string;
  cell: boolean;
}

/** One harness's slice of the v2 virtual cube — every triple its matrix
 *  provider fans out, each individually tagged with its cell membership. */
export interface HarnessCubeV2 {
  harness: HarnessName;
  triples: EnumeratedTripleV2[];
}

/**
 * Enumerate the v2 virtual launch cube: every provider fans its models (by
 * launch id) over its effective effort list ({@link matrixV2EffortsFor}),
 * except an axisless harness (hermes) which emits a single `na` triple per
 * model. The order is provider declaration order, then model declaration
 * order, then canonical ascending efforts. Pure over the matrix.
 */
export function enumerateTriplesV2(matrix: MatrixV2): HarnessCubeV2[] {
  const cells = new Set(matrix.subagentModels);
  const cube: HarnessCubeV2[] = [];
  for (const provider of matrix.providers) {
    const axisless = HARNESS_DESCRIPTORS[provider.name].secondAxis === "none";
    const triples: EnumeratedTripleV2[] = [];
    for (const [capability, launchId] of provider.models) {
      const efforts = axisless
        ? [TRIPLE_EFFORT_NA]
        : matrixV2EffortsFor(matrix, capability);
      for (const effort of efforts) {
        triples.push({
          triple: formatTriple({
            harness: provider.name,
            model: launchId,
            effort,
          }),
          capability,
          launch_id: launchId,
          effort,
          cell: cells.has(capability),
        });
      }
    }
    cube.push({ harness: provider.name, triples });
  }
  return cube;
}

/** The set of every enumerable v2 triple string in the cube — the membership
 *  oracle the doctor lints host triples against. */
export function enumerateTripleStringsV2(matrix: MatrixV2): Set<string> {
  const set = new Set<string>();
  for (const group of enumerateTriplesV2(matrix)) {
    for (const t of group.triples) {
      set.add(t.triple);
    }
  }
  return set;
}

/**
 * Lint the operator's configured launch triples against the v2 enumerable
 * cube. Each ref parses: a rejection is a `malformed-triple` fault carrying the
 * grammar error; a well-formed triple whose canonical form is absent from the
 * cube is `off-cube-triple` drift. Pure over (matrix, refs).
 */
export function lintHostTriplesV2(
  matrix: MatrixV2,
  refs: readonly HostTripleRef[],
): HostTripleFinding[] {
  const cube = enumerateTripleStringsV2(matrix);
  const findings: HostTripleFinding[] = [];
  for (const ref of refs) {
    const parsed = parseTriple(ref.raw);
    if (!parsed.ok) {
      findings.push({
        kind: "malformed-triple",
        source: ref.source,
        triple: ref.raw,
        error: parsed.error,
      });
      continue;
    }
    const canonical = formatTriple(parsed.triple);
    if (!cube.has(canonical)) {
      findings.push({
        kind: "off-cube-triple",
        source: ref.source,
        triple: canonical,
      });
    }
  }
  return findings;
}

// ── host launch-triple config (presets.yaml + panel.yaml) ────────────────────

/**
 * The operator's launch triples read from the host files — the four harness
 * defaults, the nested `dispatch:` per-verb machine-launch triples (ADR 0040;
 * the retired `worker`/`escalation` keys are no longer harvested), and every
 * panel's ordered members. Extracted leniently as RAW strings ({@link
 * extractHostTriples}) so the doctor is the sole validator; a present value is
 * a candidate triple, an absent one simply contributes no ref.
 */
export interface HostTriples {
  defaults: Partial<Record<HarnessName, string>>;
  /** Raw `dispatch:` verb → triple string, keyed by whatever verb name the
   *  operator wrote (lenient — not narrowed to the known {@link DispatchVerb}
   *  set, so an unknown/future verb still lints rather than vanishing). */
  dispatch: Record<string, string>;
  panels: Record<string, string[]>;
  panelDefault: string | null;
}

/** Flatten {@link HostTriples} into the labeled refs the doctor lints — defaults,
 *  every `dispatch:` verb (labeled `dispatch.<verb>`), then every panel member,
 *  in declaration order. */
export function hostTripleRefs(host: HostTriples): HostTripleRef[] {
  const refs: HostTripleRef[] = [];
  for (const harness of HARNESS_NAMES) {
    const value = host.defaults[harness];
    if (value !== undefined && value !== null) {
      refs.push({ source: `${harness}_default`, raw: value });
    }
  }
  for (const [verb, raw] of Object.entries(host.dispatch)) {
    refs.push({ source: `dispatch.${verb}`, raw });
  }
  for (const [panel, members] of Object.entries(host.panels)) {
    members.forEach((member, i) => {
      refs.push({ source: `panel '${panel}' member ${i + 1}`, raw: member });
    });
  }
  return refs;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extract the host launch triples from the parsed `presets.yaml` + `panel.yaml`
 * bodies — LENIENT string harvesting only (the four `<harness>_default` pointers,
 * the nested `dispatch:` verb map, the `panels` map, and its `default`), never a
 * validating parse. The doctor validates the harvested strings against the cube;
 * anything that is not a plain string is simply dropped here. Pure over the
 * parsed bodies.
 */
export function extractHostTriples(
  presetsRaw: unknown,
  panelRaw: unknown,
): HostTriples {
  const defaults: Partial<Record<HarnessName, string>> = {};
  const dispatch: Record<string, string> = {};
  const presets = asRecord(presetsRaw);
  if (presets !== null) {
    for (const harness of HARNESS_NAMES) {
      const value = asNonEmptyString(presets[`${harness}_default`]);
      if (value !== null) {
        defaults[harness] = value;
      }
    }
    const dispatchRaw = asRecord(presets.dispatch);
    if (dispatchRaw !== null) {
      for (const [verb, value] of Object.entries(dispatchRaw)) {
        const str = asNonEmptyString(value);
        if (str !== null) {
          dispatch[verb] = str;
        }
      }
    }
  }
  const panels: Record<string, string[]> = {};
  let panelDefault: string | null = null;
  const panel = asRecord(panelRaw);
  if (panel !== null) {
    const panelsRaw = asRecord(panel.panels);
    if (panelsRaw !== null) {
      for (const [name, members] of Object.entries(panelsRaw)) {
        if (Array.isArray(members)) {
          panels[name] = members.filter(
            (m): m is string => typeof m === "string",
          );
        }
      }
    }
    panelDefault = asNonEmptyString(panel.default);
  }
  return { defaults, dispatch, panels, panelDefault };
}
