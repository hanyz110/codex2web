import assert from "node:assert/strict";
import { test } from "node:test";

import * as localBridge from "../src/server/local-bridge.js";

test("default Codex discovery includes the ChatGPT desktop binary", () => {
  assert.equal(typeof localBridge.getDefaultCodexBinaryCandidates, "function");

  const candidates = localBridge.getDefaultCodexBinaryCandidates("/tmp/test-home");

  assert.equal(
    candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"),
    true,
  );
});
