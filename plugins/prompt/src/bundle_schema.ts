// Zod schema for `keeper prompt` runtime bundles. Port of promptctl
// bundle_schema.py's Pydantic v2 Bundle model.
//
// A bundle is a tiny YAML file holding an ordered, deduped list of snippet ids
// plus a few metadata fields. The schema is intentionally minimal — provenance
// is implicit from the storage location (`bundle/<name>`, `sketch/<name>`),
// token estimates are computed on demand, and snippet body content is mutable
// (drift is accepted; bundles store ids only).
//
// `.strict()` reproduces Pydantic's `extra='forbid'`: an unknown key in a
// hand-edited bundle YAML fails loudly on read instead of being silently
// ignored. The `created_at` field accepts an ISO 8601 datetime string or a Date
// (js-yaml deserializes a bare YAML timestamp to a Date) and normalizes to an
// ISO string on parse, mirroring Pydantic's datetime coercion + `mode="json"`
// serialization.

import { z } from "zod";

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A loaded + validated bundle. Field order matches the on-disk canonical YAML
 * shape (id, snippet_ids, summary, tags, created_at). */
export interface Bundle {
  id: string;
  snippet_ids: string[];
  summary: string | null;
  tags: string[];
  created_at: string;
}

/** Coerce a YAML timestamp value (Date | string) into an ISO 8601 string,
 * mirroring Pydantic's datetime parse + `model_dump(mode="json")`. */
function toIsoString(value: unknown, ctx: z.RefinementCtx): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "created_at is not a valid datetime",
      });
      return z.NEVER;
    }
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: `created_at is not a valid datetime: '${value}'`,
      });
      return z.NEVER;
    }
    return parsed.toISOString();
  }
  ctx.addIssue({ code: "custom", message: "created_at must be a datetime" });
  return z.NEVER;
}

/** The zod Bundle schema. `.strict()` rejects unknown keys (extra='forbid');
 * the kebab id regex, unique non-empty snippet_ids, and required created_at
 * mirror the Pydantic field validators. */
export const BundleSchema = z
  .object({
    id: z.string().superRefine((v, ctx) => {
      if (!KEBAB_RE.test(v)) {
        ctx.addIssue({
          code: "custom",
          message: `bundle id must be kebab-case ([a-z0-9]+(-[a-z0-9]+)*), got '${v}'`,
        });
      }
    }),
    snippet_ids: z
      .array(z.string())
      .default([])
      .superRefine((ids, ctx) => {
        const seen = new Set<string>();
        for (const sid of ids) {
          if (typeof sid !== "string" || !sid) {
            ctx.addIssue({
              code: "custom",
              message: `snippet_ids entries must be non-empty strings, got '${sid}'`,
            });
            continue;
          }
          if (seen.has(sid)) {
            ctx.addIssue({
              code: "custom",
              message: `snippet_ids contains duplicate id '${sid}'`,
            });
          }
          seen.add(sid);
        }
      }),
    summary: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    created_at: z.unknown().transform(toIsoString),
  })
  .strict();

/** Parse + validate a raw bundle mapping into a normalized Bundle. Throws a
 * ZodError on any schema violation; callers map it to their verb error type. */
export function parseBundle(data: unknown): Bundle {
  return BundleSchema.parse(data) as Bundle;
}

/** Single-line summary of a ZodError suitable for a one-line verb error message
 * (Pydantic's ValidationError str form is multi-line; we collapse to the first
 * issue's path + message, which is what a human acting on a malformed bundle
 * needs). */
export function zodErrorMessage(err: z.ZodError): string {
  const issues = err.issues;
  if (issues.length === 0) {
    return "schema validation failed";
  }
  return issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    })
    .join("; ");
}
