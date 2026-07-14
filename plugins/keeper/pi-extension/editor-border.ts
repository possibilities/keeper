/**
 * Keeper's Pi editor identity treatment: a fixed orange border with the live
 * Session title inset at the top-right. Pi owns the editor implementation, so
 * its host classes are loaded only inside the guarded installer; a missing or
 * reshaped host API leaves the stock editor untouched.
 */

export const PI_EDITOR_ORANGE_RGB = "255;159;67";

export function orangeEditorText(text: string): string {
  return `\x1b[38;2;${PI_EDITOR_ORANGE_RGB}m${text}\x1b[39m`;
}

/** Claude-style title pill: black title text on the editor's identity color. */
export function orangeEditorLabel(text: string): string {
  return (
    `\x1b[38;2;0;0;0m\x1b[48;2;${PI_EDITOR_ORANGE_RGB}m` +
    `${text}\x1b[49m\x1b[39m`
  );
}

interface EditorInstance {
  borderColor: (text: string) => string;
  render(width: number): string[];
}

interface EditorConstructor {
  new (tui: unknown, theme: unknown, keybindings: unknown): EditorInstance;
}

interface EditorHostModules {
  CustomEditor: EditorConstructor;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
  visibleWidth(text: string): number;
}

export interface PiEditorBorderApi {
  getSessionName?(): string | undefined;
}

export interface PiEditorBorderContext {
  mode?: string;
  ui?: {
    getEditorComponent?(): unknown;
    setEditorComponent?(
      factory: (tui: unknown, theme: unknown, keybindings: unknown) => unknown,
    ): void;
  };
}

export type LoadEditorHostModules = () => Promise<EditorHostModules>;

async function loadEditorHostModules(): Promise<EditorHostModules> {
  const [codingAgent, tui] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);
  return {
    CustomEditor: codingAgent.CustomEditor as EditorConstructor,
    truncateToWidth: tui.truncateToWidth,
    visibleWidth: tui.visibleWidth,
  };
}

/** Install the identity editor when Pi exposes the required TUI surface.
 * Never throws: cosmetic integration cannot break a tracked session. */
export async function installPiEditorBorder(
  pi: PiEditorBorderApi,
  context: PiEditorBorderContext,
  load: LoadEditorHostModules = loadEditorHostModules,
): Promise<void> {
  try {
    if (context.mode !== undefined && context.mode !== "tui") return;
    const ui = context.ui;
    if (
      typeof pi.getSessionName !== "function" ||
      typeof ui?.setEditorComponent !== "function"
    ) {
      return;
    }
    // Explicit caller editor customization wins over Keeper's cosmetic layer.
    if (ui.getEditorComponent?.() !== undefined) return;

    const { CustomEditor, truncateToWidth, visibleWidth } = await load();

    class KeeperEditor extends CustomEditor {
      render(width: number): string[] {
        // Pi rewrites this function when thinking/bash mode changes. Assigning it
        // immediately before the host render makes the configured identity color
        // authoritative for the frame without mutating Pi's global theme.
        this.borderColor = orangeEditorText;
        const lines = super.render(width);
        if (lines.length === 0) return lines;

        const sessionName = pi.getSessionName?.();
        if (!sessionName) return lines;
        const label = ` ${sessionName} `;
        const labelWidth = visibleWidth(label);
        const trailingBorder = "──";
        const trailingWidth = visibleWidth(trailingBorder);
        if (labelWidth + trailingWidth >= width) return lines;

        lines[0] =
          truncateToWidth(
            lines[0] ?? "",
            width - labelWidth - trailingWidth,
            "",
          ) +
          orangeEditorLabel(label) +
          orangeEditorText(trailingBorder);
        return lines;
      }
    }

    ui.setEditorComponent(
      (tui, theme, keybindings) => new KeeperEditor(tui, theme, keybindings),
    );
  } catch {
    // Host-package loading and rendering integration are advisory and fail-open.
  }
}
