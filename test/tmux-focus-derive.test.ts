/**
 * Fast-tier unit tests for the PURE tmux focus-derivation seams
 * (`src/tmux-focus-derive.ts`). NO REAL TMUX — synthetic tab-delimited `-F`
 * golden strings stand in. Covers: client/pane line parsing (tabbed name
 * safety, malformed-row drop, non-integer coercion), control-mode filtering,
 * the activity/created/name tiebreak, session→active-window→active-pane
 * composition, and the zero-real-client `none` case.
 */

import { describe, expect, test } from "bun:test";
import {
  parseClientLines,
  parsePaneLines,
  pickCurrentClient,
  type TmuxClientRow,
  type TmuxPaneRow,
} from "../src/tmux-focus-derive";

// `#{client_name}\t#{client_control_mode}\t#{client_activity}\t#{client_created}\t#{client_session}`
function clientLine(
  name: string,
  control: number,
  activity: number,
  created: number,
  session: string,
): string {
  return [name, control, activity, created, session].join("\t");
}

// `#{window_active}\t#{pane_active}\t#{window_index}\t#{pane_id}\t#{session_name}`
function paneLine(
  windowActive: number,
  paneActive: number,
  windowIndex: number | string,
  paneId: string,
  session: string,
): string {
  return [windowActive, paneActive, windowIndex, paneId, session].join("\t");
}

describe("parseClientLines", () => {
  test("parses a well-formed client row", () => {
    const rows = parseClientLines(
      clientLine("/dev/ttys001", 0, 100, 50, "main"),
    );
    expect(rows).toEqual([
      {
        name: "/dev/ttys001",
        controlMode: 0,
        activity: 100,
        created: 50,
        session: "main",
      },
    ]);
  });

  test("a session name containing a tab is preserved (final field to EOL)", () => {
    const line = ["/dev/ttys001", "0", "100", "50", "weird\tname"].join("\t");
    const rows = parseClientLines(line);
    expect(rows[0]?.session).toBe("weird\tname");
  });

  test("a row with too few tabs is dropped", () => {
    expect(parseClientLines("/dev/ttys001\t0\t100")).toEqual([]);
  });

  test("a row with an empty name is dropped", () => {
    expect(parseClientLines(clientLine("", 0, 1, 1, "main"))).toEqual([]);
  });

  test("a non-integer numeric coerces to 0, never throws", () => {
    const rows = parseClientLines("/dev/ttys001\t0\tNaN\tx\tmain");
    expect(rows[0]?.activity).toBe(0);
    expect(rows[0]?.created).toBe(0);
  });

  test("blank lines are skipped", () => {
    const text = [clientLine("/dev/ttys001", 0, 1, 1, "main"), "", ""].join(
      "\n",
    );
    expect(parseClientLines(text)).toHaveLength(1);
  });
});

describe("parsePaneLines", () => {
  test("parses a well-formed pane row with active flags", () => {
    const rows = parsePaneLines(paneLine(1, 1, 3, "%9", "main"));
    expect(rows).toEqual([
      {
        session: "main",
        windowIndex: 3,
        windowActive: true,
        paneId: "%9",
        paneActive: true,
      },
    ]);
  });

  test("a non-integer window_index coerces to null, pane still counts", () => {
    const rows = parsePaneLines("1\t1\tNaN\t%9\tmain");
    expect(rows[0]?.windowIndex).toBeNull();
    expect(rows[0]?.paneId).toBe("%9");
  });

  test("a row with an empty pane_id is dropped", () => {
    expect(parsePaneLines("1\t1\t3\t\tmain")).toEqual([]);
  });

  test("a row with an empty session is dropped", () => {
    expect(parsePaneLines("1\t1\t3\t%9\t")).toEqual([]);
  });

  test("a session name with a tab is preserved", () => {
    const rows = parsePaneLines("1\t1\t3\t%9\tweird\tname");
    expect(rows[0]?.session).toBe("weird\tname");
  });
});

describe("pickCurrentClient", () => {
  const panes: TmuxPaneRow[] = [
    {
      session: "main",
      windowIndex: 0,
      windowActive: false,
      paneId: "%1",
      paneActive: true,
    },
    {
      session: "main",
      windowIndex: 2,
      windowActive: true,
      paneId: "%5",
      paneActive: false,
    },
    {
      session: "main",
      windowIndex: 2,
      windowActive: true,
      paneId: "%6",
      paneActive: true,
    },
    {
      session: "other",
      windowIndex: 0,
      windowActive: true,
      paneId: "%9",
      paneActive: true,
    },
  ];

  test("composes session → active window → active pane", () => {
    const clients: TmuxClientRow[] = [
      {
        name: "/dev/ttys001",
        controlMode: 0,
        activity: 100,
        created: 1,
        session: "main",
      },
    ];
    expect(pickCurrentClient(clients, panes)).toEqual({
      status: "focused",
      session_name: "main",
      window_index: 2,
      pane_id: "%6",
    });
  });

  test("drops control-mode clients (keeper's own observer)", () => {
    const clients: TmuxClientRow[] = [
      {
        name: "/dev/control",
        controlMode: 1,
        activity: 999,
        created: 999,
        session: "main",
      },
    ];
    expect(pickCurrentClient(clients, panes)).toEqual({ status: "none" });
  });

  test("zero real clients → none", () => {
    expect(pickCurrentClient([], panes)).toEqual({ status: "none" });
  });

  test("a client with no attached session is dropped", () => {
    const clients: TmuxClientRow[] = [
      {
        name: "/dev/ttys001",
        controlMode: 0,
        activity: 100,
        created: 1,
        session: "",
      },
    ];
    expect(pickCurrentClient(clients, panes)).toEqual({ status: "none" });
  });

  test("picks max(activity)", () => {
    const clients: TmuxClientRow[] = [
      { name: "a", controlMode: 0, activity: 10, created: 1, session: "other" },
      { name: "b", controlMode: 0, activity: 50, created: 1, session: "main" },
    ];
    expect(pickCurrentClient(clients, panes)).toMatchObject({
      session_name: "main",
    });
  });

  test("tiebreak: equal activity → max(created)", () => {
    const clients: TmuxClientRow[] = [
      { name: "a", controlMode: 0, activity: 50, created: 1, session: "other" },
      { name: "b", controlMode: 0, activity: 50, created: 9, session: "main" },
    ];
    expect(pickCurrentClient(clients, panes)).toMatchObject({
      session_name: "main",
    });
  });

  test("tiebreak: equal activity+created → lexically-least name", () => {
    const clients: TmuxClientRow[] = [
      {
        name: "zzz",
        controlMode: 0,
        activity: 50,
        created: 5,
        session: "other",
      },
      {
        name: "aaa",
        controlMode: 0,
        activity: 50,
        created: 5,
        session: "main",
      },
    ];
    expect(pickCurrentClient(clients, panes)).toMatchObject({
      session_name: "main",
    });
  });

  test("a focused session with no resolvable active pane → none", () => {
    const clients: TmuxClientRow[] = [
      { name: "a", controlMode: 0, activity: 1, created: 1, session: "ghost" },
    ];
    expect(pickCurrentClient(clients, panes)).toEqual({ status: "none" });
  });

  test("window_index null is carried through to the focused payload", () => {
    const clients: TmuxClientRow[] = [
      { name: "a", controlMode: 0, activity: 1, created: 1, session: "s" },
    ];
    const nullIdxPanes: TmuxPaneRow[] = [
      {
        session: "s",
        windowIndex: null,
        windowActive: true,
        paneId: "%2",
        paneActive: true,
      },
    ];
    expect(pickCurrentClient(clients, nullIdxPanes)).toEqual({
      status: "focused",
      session_name: "s",
      window_index: null,
      pane_id: "%2",
    });
  });
});
