import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  forkCodexThread,
  isThreadActiveWriterConflict,
  isThreadWriterLockHeld,
} from "../src/server/codex-app-server.js";

class FakeAppServerProcess extends EventEmitter {
  constructor(response) {
    super();
    this.exitCode = null;
    this.input = "";
    this.forkResponded = false;
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
    this.stdin = {
      end: () => {},
      write: (chunk) => {
        const text = String(chunk);
        this.input += text;
        if (text.includes('"method":"thread/fork"') && !this.forkResponded) {
          this.forkResponded = true;
          queueMicrotask(() => {
            this.stdout.write(`${JSON.stringify(response)}\n`);
          });
        }
        if (text.includes('"method":"thread/name/set"')) {
          queueMicrotask(() => {
            this.stdout.write(`${JSON.stringify({ id: 3, result: {} })}\n`);
          });
        }
      },
    };
  }

  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

test("recognizes only Codex thread active-writer conflicts", () => {
  assert.equal(
    isThreadActiveWriterConflict(
      "thread-store conflict: thread abc already has an active writer (code -32600)",
    ),
    true,
  );
  assert.equal(isThreadActiveWriterConflict("thread/resume failed: file not found"), false);
});

test("detects a lock only when the writer lock file is held", () => {
  const calls = [];
  const held = isThreadWriterLockHeld("thread-12345678", {
    fileExists: () => true,
    homeDir: "/tmp/home",
    runProcess: (command, args) => {
      calls.push({ args, command });
      return { status: 0, stdout: "1162\n" };
    },
  });
  assert.equal(held, true);
  assert.equal(calls[0].command, "lsof");
  assert.match(calls[0].args[1], /thread-12345678\.lock$/);

  assert.equal(isThreadWriterLockHeld("thread-12345678", { fileExists: () => false }), false);
  assert.equal(isThreadWriterLockHeld("../invalid", { fileExists: () => true }), false);
});

test("forks a locked thread through the official app-server protocol", async () => {
  const child = new FakeAppServerProcess({
    id: 2,
    result: {
      thread: {
        id: "fork-session-id",
        path: "/tmp/fork-session.jsonl",
      },
    },
  });
  let spawnCall = null;

  const result = await forkCodexThread({
    codexBinaryPath: "/tmp/codex",
    executionPolicy: { cliArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
    session: {
      id: "source-session-id",
      name: "DEV session",
      projectPath: "/tmp/project",
    },
    spawnProcess: (binaryPath, args, options) => {
      spawnCall = { args, binaryPath, options };
      return child;
    },
  });

  assert.equal(result.sessionId, "fork-session-id");
  assert.equal(result.filePath, "/tmp/fork-session.jsonl");
  assert.equal(spawnCall.binaryPath, "/tmp/codex");
  assert.deepEqual(spawnCall.args, ["app-server", "--listen", "stdio://"]);
  assert.match(child.input, /"method":"initialize"/);
  assert.match(child.input, /"method":"initialized"/);
  assert.match(child.input, /"method":"thread\/fork"/);
  assert.match(child.input, /"threadId":"source-session-id"/);
  assert.match(child.input, /"sandbox":"danger-full-access"/);
  assert.match(child.input, /"method":"thread\/name\/set"/);
  assert.match(child.input, /DEV session（Web续接）/);
});

test("surfaces app-server fork errors", async () => {
  const child = new FakeAppServerProcess({
    error: { code: -32600, message: "fork failed" },
    id: 2,
  });

  await assert.rejects(
    forkCodexThread({
      codexBinaryPath: "/tmp/codex",
      executionPolicy: { cliArgs: [] },
      session: { id: "source-session-id", projectPath: "/tmp/project" },
      spawnProcess: () => child,
    }),
    /fork failed/,
  );
});
