/**
 * The `usage_models` keeper-config registry — the SINGLE declaration of which
 * models the usage scraper produces envelopes for and how the usage TUI renders
 * them. One map:
 *
 *   usage_models:
 *     default: claude-0      # a claude profile id, aliased to `claude-0`
 *     multi-claude-1:        # a claude profile id, no alias (renders raw)
 *     codex:                 # the codex scrape target
 *
 * Each key is an envelope id (`^[a-z0-9-]+$`): the id `codex` selects the codex
 * scrape target, every other id is a claude profile. Each value is an optional
 * display alias — a non-empty string aliases the row, `null`/absent/empty renders
 * the raw id. This ONE key replaces the retired external
 * `~/.config/agentusage/config.yaml` profile catalog AND the retired
 * `account_aliases` keeper-config map.
 *
 * Db-free island: `node:*` + `Bun.YAML` only, NEVER `src/db.ts` (the bun:sqlite
 * module). Both the SQLite-side `resolveConfig` (db.ts — the producer's account
 * set + the TUI aliases) AND the dep-free `keeper agent` cold-start picker read
 * this registry, so it must never reach db.ts. The config-path resolution
 * parallels `src/db.ts` `resolveConfigPath()` WITHOUT importing it (the
 * `src/agent/config.ts` precedent).
 *
 * Fail-open per keeper config convention: a non-map `usage_models`, or the whole
 * file missing/malformed, folds to an empty registry (`{}`) — an empty registry
 * means the producer idles and the picker rotates nothing. Within a map, a key
 * that fails the id shape is dropped individually; a non-string/empty alias keeps
 * the entry with a `null` alias (a malformed alias never un-declares a model).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The parsed registry: envelope id → display alias (`null` when unaliased). The
 * KEY set is the declared model set; the VALUES drive the cosmetic TUI aliasing.
 */
export type UsageModels = Record<string, string | null>;

/** The one id that selects the codex scrape target; every other id is a claude profile. */
export const CODEX_MODEL_ID = "codex";

/**
 * The envelope-id shape — the SAME anchored `^[a-z0-9-]+$` the consumer's
 * `isUsageFilename` applies to the `<id>.json` stem and the producer's
 * `isUsageId`. A key that fails it is dropped so a declared id can never mint an
 * envelope filename the consumer silently ignores.
 */
const USAGE_MODEL_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Parse a raw `usage_models` value into a {@link UsageModels}. Pure + fail-open:
 * a non-record (array / string / number / null) folds to `{}`; within a record a
 * key failing {@link USAGE_MODEL_ID_PATTERN} is dropped, and a non-string/empty
 * alias keeps the entry with a `null` alias.
 */
export function parseUsageModels(raw: unknown): UsageModels {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: UsageModels = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!USAGE_MODEL_ID_PATTERN.test(key)) {
      continue;
    }
    out[key] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return out;
}

/**
 * `KEEPER_CONFIG` (full path) wins; else `~/.config/keeper/config.yaml`. Mirrors
 * `src/db.ts` `resolveConfigPath()` so ONE config file drives both the SQLite-side
 * `resolveConfig` and this dep-free reader — WITHOUT importing db.ts. Pure.
 */
function keeperConfigPath(): string {
  const override = process.env.KEEPER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "keeper", "config.yaml");
}

/**
 * Read + parse the `usage_models` registry straight from keeper's config file —
 * the dep-free path the cold-start picker uses. Fail-open: a missing/unreadable
 * file, malformed YAML, or a non-mapping document all fold to `{}`.
 */
export function resolveUsageModels(): UsageModels {
  let text: string;
  try {
    text = readFileSync(keeperConfigPath(), "utf8");
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return parseUsageModels((raw as { usage_models?: unknown }).usage_models);
}

/** The declared claude profile ids — every key except `codex`, in registry order. */
export function claudeProfileIds(models: UsageModels): string[] {
  return Object.keys(models).filter((id) => id !== CODEX_MODEL_ID);
}

/** True iff the registry declares the codex scrape target. */
export function hasCodexModel(models: UsageModels): boolean {
  return Object.hasOwn(models, CODEX_MODEL_ID);
}

/**
 * The cosmetic `<id>: <alias>` map for the usage TUI — only the entries carrying
 * a non-null alias, so `aliasOf` passes an unaliased id through verbatim.
 */
export function usageModelAliases(models: UsageModels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, alias] of Object.entries(models)) {
    if (alias !== null) {
      out[id] = alias;
    }
  }
  return out;
}
