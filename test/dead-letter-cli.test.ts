import { describe, expect, test } from "bun:test";
import {
  buildDeadLetterRpcFrame,
  DeadLetterCliUsageError,
  parseDeadLetterCommand,
} from "../cli/dead-letter";

describe("keeper dead-letter", () => {
  test("reclassify builds one targeted current-parser RPC without audit fields", () => {
    const parsed = parseDeadLetterCommand([
      "reclassify",
      "poison:44:0",
      "--sock",
      "/tmp/keeper.sock",
    ]);
    expect(parsed).toEqual({
      kind: "action",
      sockPath: "/tmp/keeper.sock",
      request: { op: "reclassify", dl_id: "poison:44:0" },
    });
    if (parsed.kind !== "action") throw new Error("expected action");
    expect(buildDeadLetterRpcFrame("rpc-1", parsed, "operator")).toEqual({
      type: "rpc",
      id: "rpc-1",
      method: "resolve_dead_letter",
      params: { op: "reclassify", dl_id: "poison:44:0" },
    });
  });

  test("resolve requires force and reason and carries the acting identity", () => {
    const parsed = parseDeadLetterCommand([
      "resolve",
      "poison:44:1",
      "--force",
      "--reason",
      "  inspected malformed producer bytes  ",
      "--sock",
      "/tmp/keeper.sock",
    ]);
    expect(parsed).toEqual({
      kind: "action",
      sockPath: "/tmp/keeper.sock",
      request: {
        op: "resolve",
        dl_id: "poison:44:1",
        reason: "inspected malformed producer bytes",
        force: true,
      },
    });
    if (parsed.kind !== "action") throw new Error("expected action");
    expect(
      buildDeadLetterRpcFrame("rpc-2", parsed, "operator-session"),
    ).toEqual({
      type: "rpc",
      id: "rpc-2",
      method: "resolve_dead_letter",
      params: {
        op: "resolve",
        dl_id: "poison:44:1",
        caller_session: "operator-session",
        reason: "inspected malformed producer bytes",
        force: true,
      },
    });
  });

  test("resolve rejects missing audit inputs and reclassify rejects resolve-only flags", () => {
    const invalid = [
      ["resolve", "poison:x"],
      ["resolve", "poison:x", "--force"],
      ["resolve", "poison:x", "--reason", "why"],
      ["reclassify", "poison:x", "--force"],
      ["reclassify", "poison:x", "--reason", "why"],
    ];
    for (const argv of invalid) {
      expect(() => parseDeadLetterCommand(argv)).toThrow(
        DeadLetterCliUsageError,
      );
    }
  });
});
