const PI_SKILL_SHORTHAND = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * Prepend a configured dispatch prefix, adapting Claude-style skill shorthand
 * only when the target harness is Pi. Prefix and prompt bytes otherwise pass
 * through unchanged, apart from the separating space.
 */
export function applyDispatchPromptPrefix(
  prefix: string | undefined,
  prompt: string,
  harness?: string,
): string {
  if (prefix === undefined) return prompt;
  if (harness !== "pi") return `${prefix} ${prompt}`;

  const firstToken = /^(\s*)(\S+)([\s\S]*)$/.exec(prefix);
  if (firstToken === null) return `${prefix} ${prompt}`;

  const [, leadingWhitespace, token, suffix] = firstToken;
  const shorthand = PI_SKILL_SHORTHAND.exec(token);
  if (shorthand === null) return `${prefix} ${prompt}`;

  return `${leadingWhitespace}/skill:${shorthand[1]}${suffix} ${prompt}`;
}
