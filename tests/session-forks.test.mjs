import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectMappedForkSessionIds,
  parseSessionForkMappings,
  resolveMappedSessionId,
} from "../src/server/session-forks.js";

test("resolves chained mappings to the deepest available fork", () => {
  const mappings = new Map([
    ["original", "web-1"],
    ["web-1", "web-2"],
  ]);

  assert.equal(resolveMappedSessionId("original", mappings, new Set(["original", "web-1", "web-2"])), "web-2");
  assert.equal(resolveMappedSessionId("original", mappings, new Set(["original", "web-1"])), "web-1");
  assert.equal(resolveMappedSessionId("original", mappings, new Set(["original"])), "original");
});

test("mapping resolution stops safely on cycles", () => {
  const mappings = new Map([
    ["a", "b"],
    ["b", "a"],
  ]);
  assert.equal(resolveMappedSessionId("a", mappings, new Set(["a", "b"])), "b");
});

test("parses valid persisted mappings and collects hidden fork ids", () => {
  const mappings = parseSessionForkMappings({
    forks: {
      original: { forkSessionId: "web-1" },
      "web-1": { forkSessionId: "web-2" },
      invalid: { forkSessionId: "" },
    },
  });

  assert.deepEqual([...mappings], [["original", "web-1"], ["web-1", "web-2"]]);
  assert.deepEqual([...collectMappedForkSessionIds(mappings)], ["web-1", "web-2"]);
});
