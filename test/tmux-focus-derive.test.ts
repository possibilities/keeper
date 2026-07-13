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
  deriveFocusAndPanes,
  hashTopology,
  parseClientLines,
  parsePaneLines,
  pickCurrentClient,
  type TmuxClientRow,
  type TmuxPaneRow,
  type TmuxTopologyPane,
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

// ---------------------------------------------------------------------------
// deriveFocusAndPanes — additive widening: focus pick is byte-identical to the
// focus-only derivation AND the full parsed pane set rides alongside.
// ---------------------------------------------------------------------------

describe("deriveFocusAndPanes", () => {
  const clientsBody = clientLine("/dev/ttys001", 0, 120, 10, "main");
  const panesBody = [
    paneLine(1, 1, 3, "%42", "main"),
    paneLine(1, 0, 3, "%41", "main"),
    paneLine(0, 1, 1, "%10", "main"),
  ].join("\n");

  test("the focus half is byte-identical to the focus-only pick (contract unbroken)", () => {
    const { focus } = deriveFocusAndPanes(clientsBody, panesBody);
    const focusOnly = pickCurrentClient(
      parseClientLines(clientsBody),
      parsePaneLines(panesBody),
    );
    expect(focus).toEqual(focusOnly);
    expect(focus).toEqual({
      status: "focused",
      session_name: "main",
      window_index: 3,
      pane_id: "%42",
    });
  });

  test("the panes half is the SAME row set parsePaneLines produces", () => {
    const { panes } = deriveFocusAndPanes(clientsBody, panesBody);
    expect(panes).toEqual(parsePaneLines(panesBody));
    expect(panes).toHaveLength(3);
  });

  test("a none focus still carries the full pane set", () => {
    // Only keeper's own control client (controlMode=1) → focus is `none`, but the
    // panes are still parsed and returned (the topology emit does not gate on focus).
    const onlyControl = clientLine("/dev/ttys999", 1, 130, 11, "main");
    const { focus, panes } = deriveFocusAndPanes(onlyControl, panesBody);
    expect(focus).toEqual({ status: "none" });
    expect(panes).toHaveLength(3);
  });

  test("empty bodies → none focus, empty pane set", () => {
    const { focus, panes } = deriveFocusAndPanes("", "");
    expect(focus).toEqual({ status: "none" });
    expect(panes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hashTopology — the shared ownership-sensitive dedup hash.
// ---------------------------------------------------------------------------

describe("hashTopology", () => {
  const panes: TmuxTopologyPane[] = [
    { pane_id: "%42", session_name: "main", window_index: 3 },
    { pane_id: "%10", session_name: "work", window_index: 1 },
  ];

  test("is stable across row order (sorts by pane_id)", () => {
    expect(hashTopology("g1", panes)).toBe(
      hashTopology("g1", [...panes].reverse()),
    );
  });

  test("ownership acquisition, removal, and transfer each re-fire", () => {
    const ownedA: TmuxTopologyPane[] = [
      { ...panes[0], job_id: "sess-a" },
      panes[1] as TmuxTopologyPane,
    ];
    const ownedB: TmuxTopologyPane[] = [
      { ...panes[0], job_id: "sess-b" },
      panes[1] as TmuxTopologyPane,
    ];
    expect(hashTopology("g1", ownedA)).not.toBe(hashTopology("g1", panes));
    expect(hashTopology("g1", ownedB)).not.toBe(hashTopology("g1", ownedA));
    expect(hashTopology("g1", panes)).not.toBe(hashTopology("g1", ownedB));
  });

  test("ownership plus physical row reordering remains stable", () => {
    const owned: TmuxTopologyPane[] = [
      { ...panes[0], job_id: "sess-a" },
      { ...panes[1], job_id: "sess-b" },
    ];
    expect(hashTopology("g1", owned)).toBe(
      hashTopology("g1", [...owned].reverse()),
    );
  });

  test("a session_name change re-fires", () => {
    const moved = [{ ...panes[0], session_name: "other" }, panes[1]];
    expect(hashTopology("g1", moved)).not.toBe(hashTopology("g1", panes));
  });

  test("a window_index change re-fires", () => {
    const moved = [{ ...panes[0], window_index: 9 }, panes[1]];
    expect(hashTopology("g1", moved)).not.toBe(hashTopology("g1", panes));
  });

  test("a generation flip re-fires even at the same topology", () => {
    expect(hashTopology("g2", panes)).not.toBe(hashTopology("g1", panes));
  });

  test("an empty pane set still hashes the generation", () => {
    expect(hashTopology("g1", [])).not.toBe(hashTopology("g2", []));
  });
});
