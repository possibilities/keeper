/**
 * Session-naming logic — resolves a display name for genuinely-new sessions.
 * Pure (regex + string ops). Resolution order: slug-shortcut → agent-name
 * single-token, else null (the launcher keeps its `{cwd}-NNN` default via the
 * cwd-ordinal counter).
 */

// `<ns>:<agent>` — the agent-name shape keeper dispatches under.
const AGENT_NAME_RE = /^([\w-]+):([\w-]+)$/;
// A slug: >=2 hyphen-separated [a-z0-9] segments, optional `.N` suffix.
const SLUG_SHORTCUT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+(?:\.\d+)?$/;
// Leading slash-command token (consumed before single-token detection).
const LEADING_SLASH_COMMAND_RE = /^\/[\w:-]+\s+/;

/**
 * Return the slug token if `prompt` is a slash command followed by exactly one
 * slug-shaped token (e.g. `/work fn-53` → `fn-53`). The bare token is returned
 * verbatim — role-prefixed names are supplied upstream by keeper's `--name`.
 */
export function resolveSlugShortcut(prompt: string): string | null {
  const stripped = prompt.trim();
  // Python's str.split(None, 2): split on runs of whitespace into <=3 parts.
  const parts = splitWhitespace(stripped, 3);
  if (parts.length !== 2) {
    return null;
  }
  if (!(parts[0] as string).startsWith("/")) {
    return null;
  }
  const candidate = parts[1] as string;
  if (!SLUG_SHORTCUT_RE.test(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Split `text` on runs of whitespace into at most `maxParts` parts, mirroring
 * Python's `str.split(None, maxsplit)`: leading/trailing whitespace is dropped,
 * and the final part keeps any internal whitespace once the split budget runs
 * out.
 */
function splitWhitespace(text: string, maxParts: number): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n && out.length < maxParts - 1) {
    while (i < n && isWhitespace(text[i] as string)) {
      i += 1;
    }
    if (i >= n) {
      break;
    }
    const start = i;
    while (i < n && !isWhitespace(text[i] as string)) {
      i += 1;
    }
    out.push(text.slice(start, i));
  }
  // Remainder (with internal whitespace) becomes the last part, trimmed.
  while (i < n && isWhitespace(text[i] as string)) {
    i += 1;
  }
  if (i < n) {
    out.push(text.slice(i).replace(/\s+$/, ""));
  }
  return out;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function agentNameFrom(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const match = AGENT_NAME_RE.exec(name);
  return match ? (match[2] as string) : null;
}

/**
 * Return a session slug for `prompt`, or null to keep the caller's default.
 *
 * 1. Slug-shortcut: slash command + exactly one slug-shaped token → that token.
 * 2. Agent-name single-token: `currentName` looks like `<ns>:<agent>` and the
 *    post-strip prompt is a single token → `{token}-{agent}`.
 */
export function resolveSessionSlug(
  prompt: string,
  currentName: string | null = null,
): string | null {
  if (!prompt || !prompt.trim()) {
    return null;
  }

  const stripped = prompt.trim().replace(LEADING_SLASH_COMMAND_RE, "");

  const slugShortcut = resolveSlugShortcut(prompt);
  if (slugShortcut) {
    return slugShortcut;
  }

  const agent = agentNameFrom(currentName);
  if (agent && stripped && splitWhitespace(stripped, 2).length === 1) {
    return `${stripped}-${agent}`;
  }

  return null;
}

/**
 * Extract the trailing prompt from remaining args, if present. Returns null
 * when the last token is flag-like, or when the second-to-last token is a
 * value-taking long option in split form (so the last token is its value, not
 * a prompt). Mirrors `_extract_prompt_text`.
 */
export function extractPromptText(remainingArgs: string[]): string | null {
  if (remainingArgs.length === 0) {
    return null;
  }
  const lastArg = remainingArgs[remainingArgs.length - 1] as string;
  if (lastArg.startsWith("-")) {
    return null;
  }
  if (remainingArgs.length > 1) {
    const secondLast = remainingArgs[remainingArgs.length - 2] as string;
    if (secondLast.startsWith("--") && !secondLast.includes("=")) {
      return null;
    }
  }
  return lastArg;
}
