import { afterEach, describe, expect, test } from "bun:test";
import {
  codexObserverArgv,
  resolveCodexObserverCommand,
} from "../src/account-routing-config";

const ENV_KEY = "KEEPER_PI_CODEX_OBSERVER_BIN";
let saved: string | undefined;

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("Codex observer command resolution", () => {
  test("an explicit override wins", () => {
    saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = "/opt/custom/keeper-pi-codex-observe";
    expect(resolveCodexObserverCommand()).toBe(
      "/opt/custom/keeper-pi-codex-observe",
    );
    expect(codexObserverArgv()).toEqual([
      "/opt/custom/keeper-pi-codex-observe",
    ]);
  });

  test("an empty override falls back to the literal PATH name", () => {
    saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = "";
    expect(resolveCodexObserverCommand()).toBe("keeper-pi-codex-observe");
    expect(codexObserverArgv()).toEqual(["keeper-pi-codex-observe"]);
  });

  test("an absent override falls back to the literal PATH name", () => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    expect(resolveCodexObserverCommand()).toBe("keeper-pi-codex-observe");
    expect(codexObserverArgv("keeper-pi-codex-observe")).toEqual([
      "keeper-pi-codex-observe",
    ]);
  });
});
