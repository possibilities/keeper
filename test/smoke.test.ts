import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("version is defined", () => {
  expect(VERSION).toBeDefined();
});
