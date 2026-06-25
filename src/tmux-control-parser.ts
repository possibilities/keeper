/**
 * tmux control-mode (`tmux -C`) stream parser — PURE and dependency-free (no
 * `bun:sqlite`, no daemon imports) so it runs in the fast test tier against
 * golden transcripts.
 *
 * Control mode interleaves command-reply BLOCKS with server NOTIFICATIONS, both
 * line-oriented. A reply block is framed by a `%begin <ts> <cmdNum> <flags>`
 * header and a matching `%end <ts> <cmdNum> <flags>` (or `%error …`) trailer.
 * The frame is matched by COMMAND NUMBER ONLY (`cmdNum`) — never by ts or flags
 * — because the daemon issues commands and reads their replies by sequence. A
 * two-state machine drives the parse:
 *
 *   - `Idle`: a `%`-prefixed line is a NOTIFICATION (`%begin` enters InBlock,
 *     any other `%`-verb is decoded; unknown verbs parse-and-ignore). A
 *     non-`%` line in Idle is protocol noise and ignored.
 *   - `InBlock(cmdNum)`: every line — EVEN a `%`-prefixed one — is reply BODY
 *     until the matching `%end`/`%error <ts> cmdNum …`. This is the misframing
 *     guard: a `%output`-looking pane dump inside a block is body, not a
 *     notification.
 *
 * The line loop carries an explicit max-iteration bail-out (iTerm2 #2302
 * infinite-loop class). NOTHING throws: a malformed header/trailer or an
 * unknown verb degrades to a dropped/ignored line.
 *
 * Octal `\NNN` un-escaping is deliberately NOT done here — it belongs at a
 * presentation helper, never the protocol layer.
 */

/** A completed command-reply block, framed by `%begin`/`%end` (or `%error`) on
 *  a matching command number. `isError` is set when the trailer was `%error`. */
export interface ControlReply {
  readonly kind: "reply";
  readonly cmdNum: number;
  readonly lines: readonly string[];
  readonly isError: boolean;
}

/** A server notification seen in the Idle state (e.g.
 *  `%session-window-changed`, `%window-pane-changed`, `%client-session-changed`).
 *  `verb` is the `%`-stripped token; `args` is the remaining whitespace-split
 *  tokens. Unknown verbs are NOT emitted (parse-and-ignore). */
export interface ControlNotification {
  readonly kind: "notification";
  readonly verb: string;
  readonly args: readonly string[];
}

/** The `%exit` line. tmux emits it with an optional reason (e.g.
 *  `%exit too far behind`). After `%exit` all cached ids must be discarded. */
export interface ControlExit {
  readonly kind: "exit";
  readonly reason?: string;
}

export type ControlEvent = ControlReply | ControlNotification | ControlExit;

/** Notification verbs we decode and surface; any other `%`-verb in Idle is
 *  parse-and-ignored. `%begin` is handled by the framer, not here. Kept as a
 *  Set so the producer can decode-and-ignore unknowns without a throw. */
const KNOWN_NOTIFICATION_VERBS: ReadonlySet<string> = new Set([
  "session-changed",
  "session-window-changed",
  "session-renamed",
  "sessions-changed",
  "window-add",
  "window-close",
  "window-renamed",
  "window-pane-changed",
  "client-session-changed",
  "client-detached",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
  "layout-change",
  "output",
  "pause",
  "continue",
  "subscription-changed",
  "config-error",
]);

/** Hard ceiling on lines processed in a single parse call — an explicit
 *  bail-out so a pathological/malformed transcript can never spin forever
 *  (iTerm2 #2302). A real burst is far below this. */
const MAX_LINES = 1_000_000;

/** Split a `%begin`/`%end`/`%error` header into its command number. The line
 *  shape is `%<verb> <ts> <cmdNum> <flags>`; we read ONLY field index 2 (the
 *  command number) and ignore ts (index 1) and flags (index 3+). Returns `null`
 *  when the command number is absent or non-integer — the caller drops the
 *  frame rather than throwing. */
function frameCmdNum(tokens: readonly string[]): number | null {
  // tokens[0] is the `%verb`; tokens[2] is the command number.
  const raw = tokens[2];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * A stateful, incremental control-stream parser. `feed` is called with a chunk
 * of WHOLE lines (a string of `\n`-joined lines, the caller having already
 * framed on newlines) and returns the events that completed within this chunk;
 * a `%begin` block whose matching `%end`/`%error` has not yet arrived is carried
 * forward and emitted only once the trailer lands in a LATER `feed` — so a
 * handshake (or any reply) split across reads reassembles into exactly ONE
 * `reply` event regardless of read boundaries. Stateful, NOT pure; never throws.
 */
export interface ControlStreamParser {
  feed(text: string): ControlEvent[];
  /** True while an unterminated `%begin` block is being carried across feeds. */
  inBlock(): boolean;
}

/** Create a fresh incremental {@link ControlStreamParser}. The InBlock framing
 *  state (open command number + accumulated body lines) survives across `feed`
 *  calls, so a `%begin`/`%end` split across reads frames into one reply. */
export function createControlStreamParser(): ControlStreamParser {
  let inBlock = false;
  let blockCmdNum = 0;
  let blockLines: string[] = [];

  const feed = (text: string): ControlEvent[] => {
    const events: ControlEvent[] = [];
    const lines = text.split("\n");
    // Drop a trailing empty element produced by a terminating newline so it is
    // not mistaken for a blank protocol line.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const limit = Math.min(lines.length, MAX_LINES);
    for (let i = 0; i < limit; i++) {
      const line = lines[i] as string;

      if (inBlock) {
        // Inside a block EVERY line is body until the matching trailer — match by
        // command number only.
        if (line.startsWith("%end ") || line.startsWith("%error ")) {
          const tokens = line.split(" ");
          const cmdNum = frameCmdNum(tokens);
          if (cmdNum === blockCmdNum) {
            events.push({
              kind: "reply",
              cmdNum: blockCmdNum,
              lines: blockLines,
              isError: line.startsWith("%error "),
            });
            inBlock = false;
            blockLines = [];
            continue;
          }
          // Trailer for a DIFFERENT command number: still body (misframing guard).
        }
        blockLines.push(line);
        continue;
      }

      // Idle state.
      if (!line.startsWith("%")) {
        // Non-notification protocol noise in Idle — ignore.
        continue;
      }

      if (line.startsWith("%begin ")) {
        const tokens = line.split(" ");
        const cmdNum = frameCmdNum(tokens);
        if (cmdNum === null) {
          // Malformed header — drop it, stay Idle (never throw).
          continue;
        }
        inBlock = true;
        blockCmdNum = cmdNum;
        blockLines = [];
        continue;
      }

      if (line === "%exit" || line.startsWith("%exit ")) {
        const reason = line.length > "%exit".length ? line.slice(6) : undefined;
        events.push(
          reason !== undefined && reason !== ""
            ? { kind: "exit", reason }
            : { kind: "exit" },
        );
        continue;
      }

      // A plain notification: `%verb arg arg …`.
      const sp = line.indexOf(" ");
      const verb = sp < 0 ? line.slice(1) : line.slice(1, sp);
      if (verb === "") {
        // A bare `%` — ignore.
        continue;
      }
      if (!KNOWN_NOTIFICATION_VERBS.has(verb)) {
        // Unknown verb: parse-and-ignore (never throw).
        continue;
      }
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      const args = rest === "" ? [] : rest.split(" ");
      events.push({ kind: "notification", verb, args });
    }

    return events;
  };

  return { feed, inBlock: () => inBlock };
}

/**
 * Parse a complete control-mode transcript (a string of `\n`-joined lines) into
 * an ordered list of {@link ControlEvent}s. Pure: same input always yields the
 * same output, no I/O, no throw. A whole-transcript convenience over
 * {@link createControlStreamParser} (a single `feed`) — for golden tests and any
 * caller holding the entire transcript at once. A trailing unmatched `%begin`
 * leaves the parser InBlock with no emitted reply (discarded with the parser).
 */
export function parseControlStream(text: string): ControlEvent[] {
  return createControlStreamParser().feed(text);
}

/**
 * Decode tmux `\NNN` octal escapes in a `%output`/presentation string. tmux
 * control mode escapes non-printable bytes (and the backslash) as three-digit
 * octal. This is a PRESENTATION helper — deliberately separate from the
 * protocol parser, which must never mutate body bytes. Pure; never throws.
 */
export function decodeOctalEscapes(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/**
 * Split a `%extended-output` value at the FIRST colon: the portion before the
 * first `:` is the header (pane id + metadata), the remainder is the value
 * (which itself may contain colons). Returns `null` when there is no colon.
 * Pure; never throws.
 */
export function splitExtendedOutput(
  s: string,
): { header: string; value: string } | null {
  const colon = s.indexOf(":");
  if (colon < 0) {
    return null;
  }
  return { header: s.slice(0, colon), value: s.slice(colon + 1) };
}
