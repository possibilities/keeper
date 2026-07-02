// Snapshot canonicalizer: the ONE transform applied to both the recorded golden
// and the live `keeper prompt` output before byte-comparison.
//
// The goldens bake the capturing host's absolute repo roots into envelopes
// (`regenerate_cmd` / `source_template` / `message`) and rendered bodies. Those
// paths are environment, not behavior — they get tokenized to placeholders so a
// fixture captured on one machine (or under one temp render root) compares clean
// against a render on another. The transform is symmetric: applied identically
// to the recorded golden and the live output, so the comparison sees only
// genuine rendering divergence, never a host-path artifact.

/** Placeholder tokens for the two machine-absolute repo roots baked into
 *  envelopes and rendered bodies. Capture records the live roots in the fixture
 *  manifest; both comparison sides tokenize against them so the compare is
 *  host-independent. */
export const ARTHACK_ROOT_TOKEN = "<ARTHACK_ROOT>";
export const KEEPER_ROOT_TOKEN = "<KEEPER_ROOT>";

export interface NormalizeRoots {
  /** Absolute path to the arthack corpus repo (snippet/bundle source). */
  arthackRoot: string;
  /** Absolute path to the keeper root the fixture was rendered under (the repo
   *  root, or the temp render root used for the hermetic plan-plugin capture). */
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

/** Canonicalize a recorded golden or a live render into the host-independent
 *  comparison form: machine-absolute repo roots → placeholder tokens. This is
 *  the ONLY transform the regression-pin suite applies, and it is applied
 *  symmetrically to both sides so no incidental rewrite hides in the diff. */
export function normalize(text: string, roots: NormalizeRoots): string {
  return tokenizeRoots(text, roots);
}
