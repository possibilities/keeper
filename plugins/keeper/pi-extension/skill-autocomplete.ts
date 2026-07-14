interface PiCommandSummary {
  name: string;
  source: string;
}

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

export interface PiSkillAutocompleteApi {
  getCommands?(): PiCommandSummary[];
}

export interface PiSkillAutocompleteContext {
  ui: {
    addAutocompleteProvider?(
      factory: (current: PiAutocompleteProvider) => PiAutocompleteProvider,
    ): void;
  };
}

/**
 * Hide native skill commands when an unprefixed extension command owns the same
 * name. This changes discovery only: manually entered `/skill:<name>` commands
 * still reach Pi's native skill expansion path.
 */
export function installShadowedSkillAutocomplete(
  pi: PiSkillAutocompleteApi,
  context: PiSkillAutocompleteContext,
): void {
  if (
    typeof pi.getCommands !== "function" ||
    typeof context.ui.addAutocompleteProvider !== "function"
  ) {
    return;
  }

  const commands = pi.getCommands();
  const extensionNames = new Set(
    commands
      .filter((command) => command.source === "extension")
      .map((command) => command.name),
  );
  const hiddenSkillNames = new Set(
    commands
      .filter(
        (command) =>
          command.source === "skill" &&
          command.name.startsWith("skill:") &&
          extensionNames.has(command.name.slice("skill:".length)),
      )
      .map((command) => command.name),
  );

  if (hiddenSkillNames.size === 0) return;

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
        if (suggestions === null) return null;

        const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const isCommandDiscovery =
          options.force !== true &&
          textBeforeCursor.startsWith("/") &&
          !textBeforeCursor.includes(" ");
        if (!isCommandDiscovery) return suggestions;

        const items = suggestions.items.filter(
          (item) => !hiddenSkillNames.has(item.value.replace(/^\//, "")),
        );
        if (items.length === suggestions.items.length) return suggestions;
        if (items.length === 0) return null;
        return { ...suggestions, items };
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
