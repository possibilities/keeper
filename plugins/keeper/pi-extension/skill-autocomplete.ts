interface PiAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

interface PiAutocompleteSuggestions {
  items: PiAutocompleteItem[];
  prefix: string;
}

interface PiAutocompleteOptions {
  signal: AbortSignal;
  force?: boolean;
}

interface PiCompletionResult {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface PiAutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: PiAutocompleteOptions,
  ): Promise<PiAutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: PiAutocompleteItem,
    prefix: string,
  ): PiCompletionResult;
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
}

export interface PiSkillAutocompleteContext {
  ui: {
    addAutocompleteProvider?(
      factory: (current: PiAutocompleteProvider) => PiAutocompleteProvider,
    ): void;
  };
}

export interface PiSkillShorthand {
  readonly name: string;
  readonly description: string;
}

/**
 * Keeper's canonical short aliases for its Hack and Plan Agent Skills. The
 * name doubles as the native skill it expands to (`/hack` → `/skill:hack`)
 * and as the directory name under `plugins/plan/skills/` a
 * `resources_discover` response contributes — one list, three consumers.
 */
export const SKILL_SHORTHANDS: readonly PiSkillShorthand[] = [
  { name: "hack", description: "Run the hack skill workflow on a request" },
  {
    name: "plan",
    description: "Run the plan skill workflow on a planning request",
  },
];

const SKILL_SHORTHAND_PATTERN = new RegExp(
  `^/(${SKILL_SHORTHANDS.map((shorthand) => shorthand.name).join("|")})(?=$|\\s)`,
);

/**
 * Rewrite a leading complete `/hack` or `/plan` token to its native
 * `/skill:*` form, preserving the remaining text untouched. Near misses
 * (`/hacker`, `/hack/path`), leading whitespace, and already-native
 * `/skill:*` input pass through unchanged so Pi's own skill pipeline stays
 * the sole authority once expansion begins.
 */
export function expandSkillShorthandInput(text: string): string {
  return text.replace(SKILL_SHORTHAND_PATTERN, "/skill:$1");
}

/**
 * Prepend Keeper's short aliases to Pi's slash-command discovery so `/hack`
 * and `/plan` are offered before the skills they resolve to would otherwise
 * surface — without registering extension commands (which would bypass
 * native skill expansion) or depending on a pre-discovery command snapshot.
 * Delegation to the wrapped provider's own matches, trigger characters, and
 * completion application is otherwise unchanged.
 */
export function installSkillShorthandAutocomplete(
  context: PiSkillAutocompleteContext,
): void {
  if (typeof context.ui.addAutocompleteProvider !== "function") return;

  context.ui.addAutocompleteProvider((current) => {
    const shouldTriggerFileCompletion = current.shouldTriggerFileCompletion;
    return {
      ...(current.triggerCharacters === undefined
        ? {}
        : { triggerCharacters: current.triggerCharacters }),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options,
        );
        const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const isCommandDiscovery =
          options.force !== true &&
          textBeforeCursor.startsWith("/") &&
          !textBeforeCursor.includes(" ");
        if (!isCommandDiscovery) return suggestions;

        const commandPrefix = textBeforeCursor.slice(1);
        const aliases = SKILL_SHORTHANDS.filter(({ name }) =>
          name.startsWith(commandPrefix),
        ).map(({ name, description }) => ({
          value: `/${name}`,
          label: name,
          description,
        }));
        if (aliases.length === 0) return suggestions;

        const seen = new Set(aliases.map(({ value }) => value));
        const existing = (suggestions?.items ?? []).filter(
          (item) => !seen.has(item.value),
        );
        return {
          prefix: suggestions?.prefix ?? textBeforeCursor,
          items: [...aliases, ...existing],
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      },
      ...(shouldTriggerFileCompletion === undefined
        ? {}
        : {
            shouldTriggerFileCompletion(
              lines: string[],
              cursorLine: number,
              cursorCol: number,
            ) {
              return shouldTriggerFileCompletion.call(
                current,
                lines,
                cursorLine,
                cursorCol,
              );
            },
          }),
    };
  });
}
