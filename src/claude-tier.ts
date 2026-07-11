/**
 * Db-free leaf: the Claude plan-tier → multiplier table, the `.claude.json` read
 * cap, and the single tier-resolvable predicate. Used by the usage-scraper
 * PRODUCER (`parseTierMultiplier` in `usage-scraper-worker.ts`, which drags in
 * `src/db.ts`), routing its tier check through {@link resolveTierMultiplier} so
 * `keeper usage` never disagrees with itself on whether a tier resolves.
 *
 * No deps beyond the type system — importable on any cold path.
 */

/**
 * Plan-tier string → multiplier. Source of truth:
 * `~/.claude[-profiles/<p>]/.claude.json:oauthAccount.organizationRateLimitTier`.
 * Pro (1x), Max-5x, Max-20x. Codex has no tier — treated as 1x.
 */
export const TIER_MULTIPLIERS: Record<string, number> = {
  default_claude_ai: 1,
  default_claude_max_5x: 5,
  default_claude_max_20x: 20,
};

/**
 * Cap a `.claude.json` read so a runaway file never balloons boot memory. Real
 * configs run 1.7-2.4 MB and grow with history, so the cap only fences off a
 * pathological file — set well above the live range with headroom to spare.
 */
export const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Resolve a plan-tier value to its multiplier, or `null` when the tier is
 * absent / not a string / not a known key. The ONE tier-resolvable predicate;
 * a `null` is the "tier unresolvable" signal both consumers key off of.
 */
export function resolveTierMultiplier(tier: unknown): number | null {
  if (typeof tier !== "string") {
    return null;
  }
  return TIER_MULTIPLIERS[tier] ?? null;
}
