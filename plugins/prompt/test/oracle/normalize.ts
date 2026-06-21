// The differential-parity normalizer: the ONE intentional diff between the
// Python `promptctl` oracle and the ported `keeper prompt` engine.
//
// The port renames the binary, so two byte-shapes drift on purpose:
//   1. command/regenerate cites: the literal `promptctl ` verb prefix becomes
//      `keeper prompt ` (in `regenerate_cmd`, sidecar `_warning` bodies, and the
//      block/warn message text the hooks surface).
//   2. machine-absolute paths: the oracle bakes the capturing host's absolute
//      repo roots into `regenerate_cmd` / `source_template` / `message`. Those
//      are environment, not behavior — they get tokenized so a fixture captured
//      on one machine compares clean against a render on another.
//
// Both transforms are applied to BOTH sides before byte-comparison, so the
// parity assertion sees only genuine rendering divergence. Path tokenization is
// symmetric (oracle and candidate alike); the verb substitution is one-way
// (oracle `promptctl ` → canonical `keeper prompt `) because that is the single
// sanctioned behavioral change of the port.

/** The oracle's verb prefix. A trailing space scopes it to command position so
 *  a snippet body that merely mentions the word "promptctl" is untouched. */
const ORACLE_VERB = "promptctl ";
/** The ported engine's verb prefix. */
const KEEPER_VERB = "keeper prompt ";

/** Placeholder tokens for the two machine-absolute repo roots the oracle bakes
 *  into envelopes. Capture records the live roots in the fixture manifest; both
 *  comparison sides tokenize against them so the compare is host-independent. */
export const ARTHACK_ROOT_TOKEN = "<ARTHACK_ROOT>";
export const KEEPER_ROOT_TOKEN = "<KEEPER_ROOT>";

export interface NormalizeRoots {
  /** Absolute path to the arthack corpus repo (snippet/bundle source). */
  arthackRoot: string;
  /** Absolute path to the keeper repo (plugin-template consumer root). */
  keeperRoot: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace every occurrence of `find` with `replace` (literal, global). */
function replaceAll(text: string, find: string, replace: string): string {
  if (find === "") {
    return text;
  }
  return text.replace(new RegExp(escapeRegExp(find), "g"), replace);
}

/** Tokenize machine-absolute repo roots to placeholders. Longest-path-first so
 *  a keeper root nested under arthack (or vice-versa) can't be half-tokenized. */
export function tokenizeRoots(text: string, roots: NormalizeRoots): string {
  const pairs: Array<[string, string]> = [
    [roots.arthackRoot, ARTHACK_ROOT_TOKEN],
    [roots.keeperRoot, KEEPER_ROOT_TOKEN],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [root, token] of pairs) {
    if (root) {
      out = replaceAll(out, root, token);
    }
  }
  return out;
}

/** Apply the one-way verb substitution `promptctl ` → `keeper prompt ` to the
 *  ORACLE side only. The candidate already emits `keeper prompt `, so it is a
 *  no-op there — calling it on both sides is safe and idempotent. */
export function substituteVerb(text: string): string {
  return replaceAll(text, ORACLE_VERB, KEEPER_VERB);
}

/** Full normalization applied to the ORACLE fixture before comparison: tokenize
 *  roots, then rename the verb. This is the canonical form every later
 *  verb-port task asserts its candidate output against. */
export function normalizeOracle(text: string, roots: NormalizeRoots): string {
  return substituteVerb(tokenizeRoots(text, roots));
}

/** Normalization applied to the CANDIDATE (`keeper prompt`) output before
 *  comparison: tokenize roots only — the candidate already speaks
 *  `keeper prompt`, so no verb rewrite is owed. Kept distinct from
 *  `normalizeOracle` so the asymmetry of the port is explicit at the callsite. */
export function normalizeCandidate(
  text: string,
  roots: NormalizeRoots,
): string {
  return substituteVerb(tokenizeRoots(text, roots));
}
