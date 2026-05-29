import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeepSeekSafeForkPrompt,
  resolveModelSelection,
} from "../src/server/providers/claude-readonly-bridge.js";

test("buildDeepSeekSafeForkPrompt carries recent visible context and the latest request", () => {
  const transcript = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index + 1}`,
    time: `2026-05-29T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
  }));

  const prompt = buildDeepSeekSafeForkPrompt({
    latestPrompt: "继续处理当前问题",
    sourceSessionId: "source-session",
    transcript,
  });

  assert.match(prompt, /DeepSeek 安全分支/);
  assert.match(prompt, /source-session/);
  assert.match(prompt, /message-18/);
  assert.match(prompt, /继续处理当前问题/);
  assert.equal(prompt.includes("\nmessage-1\n"), false);
});

test("resolveModelSelection honors requested provider before cliModel aliases", () => {
  const catalog = [
    {
      cliModel: "claude-opus-4-7",
      id: "deepseek:deepseek-v4-pro[1m]",
      label: "DeepSeek: deepseek-v4-pro[1m]",
      model: "deepseek-v4-pro[1m]",
      provider: "deepseek",
    },
    {
      cliModel: "claude-opus-4-7",
      id: "claude:claude-opus-4-7",
      label: "Opus 4.7",
      model: "claude-opus-4-7",
      provider: "claude",
    },
  ];

  const selected = resolveModelSelection(catalog, {
    model: "claude-opus-4-7",
    provider: "claude",
  });

  assert.equal(selected.provider, "claude");
  assert.equal(selected.model, "claude-opus-4-7");
});

test("buildDeepSeekSafeForkPrompt does not nest previous safe-fork scaffolds", () => {
  const prompt = buildDeepSeekSafeForkPrompt({
    latestPrompt: "继续",
    sourceSessionId: "next-source",
    transcript: [
      {
        role: "user",
        text: "这是一个自动创建的 DeepSeek 安全分支。\n来源 Claude session: old\n\n用户最新请求：\n旧请求",
        time: "2026-05-29T00:00:00.000Z",
      },
      {
        role: "assistant",
        text: "真实助手回复",
        time: "2026-05-29T00:01:00.000Z",
      },
    ],
  });

  assert.equal((prompt.match(/这是一个自动创建的 DeepSeek 安全分支/g) || []).length, 1);
  assert.match(prompt, /真实助手回复/);
  assert.doesNotMatch(prompt, /旧请求/);
});
