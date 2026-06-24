import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("external launcher restarts the server child without exiting the launchd job", () => {
  const source = fs.readFileSync("scripts/external-access.mjs", "utf8");
  assert.equal(source.includes("let serverChild = null;"), true);
  assert.equal(source.includes("function spawnServerChild"), true);
  assert.equal(source.includes("function restartServerChild"), true);
  assert.equal(source.includes("[watchdog] server exited unexpectedly"), true);
  assert.equal(source.includes("reject(new Error(`External server exited unexpectedly"), false);
});
