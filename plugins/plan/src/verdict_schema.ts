// Close-phase verdict schema + reject-envelope builder — the byte-parity port of
// planctl/verdict_schema.py for the submit verbs.
//
// The close-planner emits this verdict and `planctl verdict submit` validates it
// at emission:
//
//     {
//       "fatal": bool,
//       "fatal_reason": str,
//       "blocks_closing": bool,          # optional; absent = legacy non-blocking
//       "blocks_closing_reason": str,    # optional; non-empty iff blocks_closing
//       "decisions": [
//         {"fid": str, "action": "kept"|"culled"|"merged-into-<fid>",
//          "task": int|null, "rationale": str},
//         ...
//       ]
//     }
//
// `additionalProperties: false` on every object node keeps the wire shape tight.
// The submit verb runs the STRUCTURAL pass (schemaErrors) THEN crossFieldErrors
// (the invariants the structural pass cannot express).
//
// PARITY: schemaErrors is a HAND-ROLLED validator reproducing python-jsonschema
// semantics for exactly the keywords the schema uses (type incl. the
// [integer,null] union, required, additionalProperties:false, minLength,
// pattern), emitting {loc,type,msg} rows whose `msg` text matches
// python-jsonschema's exact wording — the load-bearing parity surface captured
// in tests/fixtures/golden/verdict/. ajv's wording diverges (best_match vs
// errors[0]) and would need a translation table anyway, so we own the strings.
//
// The reject UX is deliberately minimal: the TOP-3 errors only and the minimal
// schema fragment for the single offending path — never the whole schema in a
// retry prompt. buildRejectEnvelope assembles that shape.

/** `merged-into-<fid>` action prefix. */
const MERGED_INTO_PREFIX = "merged-into-";

const ACTION_PATTERN = "^(kept|culled|merged-into-.+)$";

/** Length cap on the optional `blocks_closing_reason` — a bounded one-paragraph
 * justification, never an essay. Exported so a test can pin the boundary. */
export const BLOCKS_CLOSING_REASON_MAX = 2000;

export interface ErrorRow {
  loc: string;
  type: string;
  msg: string;
}

type Schema = Record<string, unknown>;

/** The small verdict JSON schema. Every object node pins
 * additionalProperties:false. The action enum is open-ended on the merge variant
 * (any `merged-into-<fid>` string), so the schema constrains it with a regex
 * pattern and crossFieldErrors does the fid-existence cross-check. Mirrors
 * VERDICT_SCHEMA — kept as a data structure so schemaFragmentForLoc can slice it
 * the same way Python does. */
export const VERDICT_SCHEMA: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["fatal", "fatal_reason", "decisions"],
  properties: {
    fatal: { type: "boolean" },
    fatal_reason: { type: "string" },
    // Optional close-gate pair, shaped exactly like fatal/fatal_reason: a strict
    // boolean plus its length-capped reason (non-empty when true, cross-checked
    // below). Absent means legacy non-blocking; a non-boolean or over-cap reason
    // is rejected at submit so garbage never coerces toward the irreversible close.
    blocks_closing: { type: "boolean" },
    blocks_closing_reason: {
      type: "string",
      maxLength: BLOCKS_CLOSING_REASON_MAX,
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fid", "action", "task", "rationale"],
        properties: {
          fid: { type: "string", minLength: 1 },
          action: { type: "string", pattern: ACTION_PATTERN },
          task: { type: ["integer", "null"] },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

function mergeTarget(action: string): string | null {
  return action.startsWith(MERGED_INTO_PREFIX)
    ? action.slice(MERGED_INTO_PREFIX.length)
    : null;
}

/** python-jsonschema's repr of a value inside a message: single-quoted for a
 * string (its Python repr), `True`/`False` for booleans, lowercase JSON-ish for
 * the rest. The golden messages embed `'nope'` / `''` / `'bogus-action'`, all
 * strings, so string repr is the load-bearing case. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === null) {
    return "None";
  }
  return JSON.stringify(value);
}

/** True iff `value` satisfies a JSON Schema `type` keyword (a single name or a
 * union array). Mirrors jsonschema's type check, including the `boolean is not
 * integer` distinction (Python bool is a subclass of int, but jsonschema's
 * type checker treats bool as NOT integer). */
function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => matchesSingleType(value, t));
}

function matchesSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      return false;
  }
}

/** Run the structural VERDICT_SCHEMA pass, returning machine-readable
 * {loc,type,msg} rows. `loc` is the dotted/indexed JSON path
 * (decisions[2].action), `type` is the failing validator keyword, `msg` is the
 * message text matching python-jsonschema byte-for-byte. Empty list ⇒
 * structurally valid. Mirrors schema_errors.
 *
 * Validation order per node matches jsonschema's iter_errors emission for the
 * single-rule golden inputs: type → required → additionalProperties at the
 * object level, then recurse into each present property; for arrays, validate
 * each item. */
export function schemaErrors(verdict: unknown): ErrorRow[] {
  const rows: ErrorRow[] = [];
  validateNode(verdict, VERDICT_SCHEMA, "", rows);
  return rows;
}

function validateNode(
  value: unknown,
  schema: Schema,
  loc: string,
  rows: ErrorRow[],
): void {
  const type = schema.type as string | string[] | undefined;
  if (type !== undefined && !matchesType(value, type)) {
    rows.push({
      loc: loc || "<root>",
      type: "type",
      msg: `${pyRepr(value)} is not of type ${typeNamesForMessage(type)}`,
    });
    // jsonschema stops descending into a node whose own type is wrong.
    return;
  }

  if (typeof value === "string") {
    validateString(value, schema, loc, rows);
    return;
  }

  if (Array.isArray(value)) {
    const items = schema.items as Schema | undefined;
    if (items) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(value[i], items, `${loc}[${i}]`, rows);
      }
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    validateObject(value as Record<string, unknown>, schema, loc, rows);
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: Schema,
  loc: string,
  rows: ErrorRow[],
): void {
  const required = (schema.required as string[] | undefined) ?? [];
  const properties = (schema.properties as Record<string, Schema>) ?? {};

  // required: one error per missing property, in declared order.
  for (const key of required) {
    if (!(key in value)) {
      rows.push({
        loc: loc || "<root>",
        type: "required",
        msg: `${pyRepr(key)} is a required property`,
      });
    }
  }

  // additionalProperties: false — one error per unexpected key, in input order.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        rows.push({
          loc: loc || "<root>",
          type: "additionalProperties",
          msg: `Additional properties are not allowed (${pyRepr(key)} was unexpected)`,
        });
      }
    }
  }

  // Recurse into each present, schema-known property.
  for (const key of Object.keys(value)) {
    const propSchema = properties[key];
    if (propSchema) {
      const childLoc = loc ? `${loc}.${key}` : key;
      validateNode(value[key], propSchema, childLoc, rows);
    }
  }
}

function validateString(
  value: string,
  schema: Schema,
  loc: string,
  rows: ErrorRow[],
): void {
  const minLength = schema.minLength as number | undefined;
  if (minLength !== undefined && value.length < minLength) {
    rows.push({
      loc: loc || "<root>",
      type: "minLength",
      // jsonschema special-cases minLength:1 to "… should be non-empty".
      msg:
        minLength === 1
          ? `${pyRepr(value)} should be non-empty`
          : `${pyRepr(value)} is too short`,
    });
  }
  const maxLength = schema.maxLength as number | undefined;
  if (maxLength !== undefined && value.length > maxLength) {
    rows.push({
      loc: loc || "<root>",
      type: "maxLength",
      msg: `${pyRepr(value)} is too long`,
    });
  }
  const pattern = schema.pattern as string | undefined;
  if (pattern !== undefined && !new RegExp(pattern).test(value)) {
    rows.push({
      loc: loc || "<root>",
      type: "pattern",
      msg: `${pyRepr(value)} does not match ${pyRepr(pattern)}`,
    });
  }
}

/** Render a `type` keyword for an `is not of type` message the way
 * python-jsonschema does: a single name as `'name'`, a union as
 * `'a', 'b'`. The verdict schema only triggers the single-name case in the
 * goldens. */
function typeNamesForMessage(type: string | string[]): string {
  if (Array.isArray(type)) {
    return type.map((t) => `'${t}'`).join(", ");
  }
  return `'${type}'`;
}

/** Cross-field invariants jsonschema cannot express, as {loc,type,msg} rows.
 * Assumes `verdict` already passed the structural pass (the caller runs that
 * first and short-circuits on its errors). Mirrors cross_field_errors:
 *
 *   * fatal:true ⇒ non-empty fatal_reason
 *   * every merged-into-<fid> target references an existing decision fid
 *   * culled ⇒ task null
 *   * kept / merged-into-* ⇒ task is a non-null integer ordinal (bool rejected)
 */
export function crossFieldErrors(verdict: Record<string, unknown>): ErrorRow[] {
  const errors: ErrorRow[] = [];

  const fatal = verdict.fatal;
  const fatalReason = verdict.fatal_reason ?? "";
  if (
    fatal === true &&
    !(typeof fatalReason === "string" && fatalReason.trim() !== "")
  ) {
    errors.push({
      loc: "fatal_reason",
      type: "fatal_reason_required",
      msg: "fatal: true requires a non-empty fatal_reason",
    });
  }

  // The close-gate pair, enforced exactly like fatal/fatal_reason: a true
  // blocking decision demands a non-empty reason.
  const blocksClosing = verdict.blocks_closing;
  const blocksClosingReason = verdict.blocks_closing_reason ?? "";
  if (
    blocksClosing === true &&
    !(
      typeof blocksClosingReason === "string" &&
      blocksClosingReason.trim() !== ""
    )
  ) {
    errors.push({
      loc: "blocks_closing_reason",
      type: "blocks_closing_reason_required",
      msg: "blocks_closing: true requires a non-empty blocks_closing_reason",
    });
  }

  const decisions = (verdict.decisions as unknown[]) ?? [];
  const knownFids = new Set<string>();
  for (const d of decisions) {
    if (isObject(d) && typeof d.fid === "string") {
      knownFids.add(d.fid);
    }
  }

  decisions.forEach((decision, idx) => {
    if (!isObject(decision)) {
      return; // structural pass already flagged this
    }
    const action = typeof decision.action === "string" ? decision.action : "";
    const task = decision.task;
    const locBase = `decisions[${idx}]`;

    const target = mergeTarget(action);
    if (target !== null && !knownFids.has(target)) {
      errors.push({
        loc: `${locBase}.action`,
        type: "dangling_merge_target",
        msg:
          `merged-into target fid ${pyRepr(target)} does not match any ` +
          "decision fid in this verdict",
      });
    }

    if (action === "culled") {
      if (task !== null && task !== undefined) {
        errors.push({
          loc: `${locBase}.task`,
          type: "culled_task_not_null",
          msg: "a culled decision must have task: null",
        });
      }
    } else if (action === "kept" || target !== null) {
      // kept or a (well-formed) merge ⇒ a real follow-up ordinal. A boolean is
      // explicitly NOT an integer ordinal (mirrors the Python bool-reject).
      if (typeof task !== "number" || !Number.isInteger(task)) {
        errors.push({
          loc: `${locBase}.task`,
          type: "task_ordinal_required",
          msg:
            `a ${pyRepr(action)} decision must carry a non-null integer ` +
            "task ordinal",
        });
      }
    }
  });

  return errors;
}

/** The minimal schema fragment governing the offending `loc`. Walks
 * VERDICT_SCHEMA to the narrowest sub-schema for the dotted/indexed path; on any
 * miss, returns the top-level required/property skeleton so the retry prompt
 * always has SOME anchor — never the full nested schema. Mirrors
 * _schema_fragment_for_loc. */
function schemaFragmentForLoc(loc: string): Schema {
  const props = (VERDICT_SCHEMA.properties as Record<string, Schema>) ?? {};

  // A decisions[...] path drills into the item schema's property.
  const m = /^decisions(?:\[\d+\])?(?:\.(\w+))?$/.exec(loc);
  if (m) {
    const itemSchema = ((props.decisions?.items as Schema) ?? {}) as Schema;
    const sub = m[1];
    if (sub !== undefined) {
      const frag = (itemSchema.properties as Record<string, Schema>)?.[sub];
      if (frag !== undefined) {
        return { [sub]: frag };
      }
    }
    // Bare decisions / decisions[i] → the item required+props skeleton.
    return {
      required: (itemSchema.required as string[]) ?? [],
      properties: (itemSchema.properties as Record<string, Schema>) ?? {},
    };
  }

  const head = loc.split(/[.[]/, 1)[0] as string;
  if (head in props) {
    return { [head]: props[head] as Schema };
  }

  // Fallback anchor: top-level skeleton (required keys + their bare types). The
  // optional close-gate pair is deliberately excluded — the retry anchor names
  // only the fields a valid verdict MUST carry.
  const required = (VERDICT_SCHEMA.required as string[]) ?? [];
  const skeleton: Record<string, Schema> = {};
  for (const [k, v] of Object.entries(props)) {
    if ("type" in v && required.includes(k)) {
      skeleton[k] = { type: v.type as unknown as Schema };
    }
  }
  return {
    required,
    properties: skeleton,
  };
}

export interface RejectEnvelope {
  success: false;
  error: {
    code: "VERDICT_INVALID";
    message: string;
    details: {
      errors: ErrorRow[];
      error_count: number;
      schema_fragment: Schema;
    };
  };
}

/** Assemble the typed verdict-reject envelope from the combined structural +
 * cross-field rows. Surfaces the TOP-3 errors and the minimal schema fragment
 * for the FIRST error's path only — never the full schema. error_count reports
 * the true total so the agent knows the list was truncated. Mirrors
 * build_reject_envelope. */
export function buildRejectEnvelope(errors: ErrorRow[]): RejectEnvelope {
  const top = errors.slice(0, 3);
  const firstLoc = errors.length > 0 ? (errors[0] as ErrorRow).loc : "";
  return {
    success: false,
    error: {
      code: "VERDICT_INVALID",
      message:
        `verdict failed validation (${errors.length} error(s)); ` +
        "fix the listed paths and resubmit",
      details: {
        errors: top,
        error_count: errors.length,
        schema_fragment: schemaFragmentForLoc(firstLoc),
      },
    },
  };
}

/** Full validation pass mirroring the submit verb: structural errors first,
 * cross-field only when structurally clean, then the reject envelope — or null
 * when the verdict is valid. */
export function validateVerdict(verdict: unknown): RejectEnvelope | null {
  let errors = schemaErrors(verdict);
  if (errors.length === 0 && isObject(verdict)) {
    errors = crossFieldErrors(verdict as Record<string, unknown>);
  }
  if (errors.length === 0) {
    return null;
  }
  return buildRejectEnvelope(errors);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
