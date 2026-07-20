import { expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveNonFableFocus,
  materializeNonFableFocusPolicy,
  normalizeNonFableFocusInput,
  publishNonFableFocusLeaf,
  readNonFableFocusLeaf,
  serializeNonFableFocusLeaf,
} from "../src/account-focus";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const DEADLINE = "2026-07-20T23:59:59.000Z";

function policy(
  lifetime: { kind: "permanent" } | { kind: "absolute"; deadline_at: string },
) {
  const result = materializeNonFableFocusPolicy(
    { target_route: "claude-swap:2", lifetime },
    42,
    NOW / 1_000,
  );
  if (result === null) throw new Error("expected policy");
  return result;
}

test("Non-Fable input accepts only stable routes and permanent or absolute lifetimes", () => {
  expect(
    normalizeNonFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: { kind: "permanent" },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "permanent" },
  });
  expect(
    normalizeNonFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: {
        kind: "absolute",
        deadline_at: "2026-07-20T19:59:59-04:00",
      },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "absolute", deadline_at: DEADLINE },
  });
  for (const value of [
    {
      target_route: "person@example.com",
      lifetime: { kind: "permanent" },
    },
    {
      target_route: "claude-swap:2\n",
      lifetime: { kind: "permanent" },
    },
    {
      target_route: "claude-swap:2",
      lifetime: { kind: "cycle-end", reset_at: DEADLINE },
    },
    {
      target_route: "claude-swap:2",
      lifetime: { kind: "permanent" },
      email: "person@example.com",
    },
  ]) {
    expect(normalizeNonFableFocusInput(value)).toBeNull();
  }
});

test("Non-Fable policy identity and timestamp are event-owned", () => {
  expect(policy({ kind: "permanent" })).toEqual({
    schema_version: 1,
    policy_id: "event:42",
    target_route: "claude-swap:2",
    fable_intent: false,
    set_at: "2026-07-18T12:00:00.000Z",
    lifetime: { kind: "permanent" },
  });
  expect(
    materializeNonFableFocusPolicy(
      { target_route: "claude-swap:2", lifetime: { kind: "permanent" } },
      0,
      NOW / 1_000,
    ),
  ).toBeNull();
});

test("Non-Fable lifetime evaluation is permanent or half-open absolute", () => {
  expect(
    effectiveNonFableFocus(
      { available: true, policy: policy({ kind: "permanent" }) },
      null,
      NOW,
    ).state,
  ).toBe("active");
  const absolute = policy({ kind: "absolute", deadline_at: DEADLINE });
  const deadline = Date.parse(DEADLINE);
  expect(
    effectiveNonFableFocus(
      { available: true, policy: absolute },
      null,
      deadline - 1,
    ).state,
  ).toBe("active");
  expect(
    effectiveNonFableFocus(
      { available: true, policy: absolute },
      null,
      deadline,
    ).state,
  ).toBe("expired");
});

test("Non-Fable leaf is bounded, owner-only, scoped, and refuses insecure delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-account-focus-"));
  const path = join(dir, "policy.json");
  try {
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-missing",
    });
    writeFileSync(path, "not-json", { mode: 0o600 });
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-malformed",
    });
    writeFileSync(path, '{"schema_version":99,"policy":null}\n', {
      mode: 0o600,
    });
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-unsupported",
    });
    const expected = policy({ kind: "permanent" });
    publishNonFableFocusLeaf(path, expected);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(
      serializeNonFableFocusLeaf(expected),
    );
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: true,
      policy: expected,
    });
    chmodSync(path, 0o644);
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-insecure",
    });
    rmSync(path);
    const target = join(dir, "target.json");
    writeFileSync(target, serializeNonFableFocusLeaf(expected), {
      mode: 0o600,
    });
    symlinkSync(target, path);
    expect(readNonFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-insecure",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Non-Fable atomic publication preserves the prior leaf on replacement failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-account-focus-"));
  const path = join(dir, "policy.json");
  try {
    publishNonFableFocusLeaf(path, policy({ kind: "permanent" }));
    const before = readFileSync(path, "utf8");
    expect(() =>
      publishNonFableFocusLeaf(path, null, {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    ).toThrow("injected rename failure");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["policy.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
