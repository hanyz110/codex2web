import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClaudePromptWithImages,
  buildDeepSeekSafeForkPrompt,
  discoverDynamicModelCatalog,
  extractClaudeToolActivity,
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

test("buildClaudePromptWithImages uses native image file context for Claude models", () => {
  const prompt = buildClaudePromptWithImages("看图说明", ["/tmp/example.png"], {
    imageMode: "native",
  });

  assert.match(prompt, /直接读取并理解这些本地图片/);
  assert.match(prompt, /\/tmp\/example\.png/);
  assert.doesNotMatch(prompt, /服务端 OCR/);
  assert.doesNotMatch(prompt, /DeepSeek Anthropic 兼容接口/);
});

test("buildClaudePromptWithImages keeps OCR fallback for DeepSeek models", () => {
  const prompt = buildClaudePromptWithImages("看图说明", ["/tmp/example.png"], {
    imageAnalyses: [
      {
        lineCount: 1,
        path: "/tmp/example.png",
        text: "HELLO IMAGE",
      },
    ],
    imageMode: "ocr",
  });

  assert.match(prompt, /DeepSeek Anthropic 兼容接口/);
  assert.match(prompt, /服务端 OCR 识别文本/);
  assert.match(prompt, /HELLO IMAGE/);
});

test("discoverDynamicModelCatalog includes models advertised by Claude CLI help", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-test-cli-"));
  const fakeClaude = path.join(tempDir, "claude");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "cat <<'EOF'",
      "Usage: claude [options] [prompt]",
      "  --model <model>  e.g. 'sonnet' or 'opus' or full name 'claude-opus-4-8'",
      "EOF",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);

  try {
    const catalog = await discoverDynamicModelCatalog({ claudeBinaryPath: fakeClaude });
    const opus48 = catalog.find((option) => option.id === "claude:claude-opus-4-8");
    const opus47 = catalog.find((option) => option.id === "claude:claude-opus-4-7");

    assert.equal(opus48?.provider, "claude");
    assert.match(opus48?.source || "", /claude-cli-help/);
    if (opus47) {
      assert.ok(catalog.indexOf(opus48) < catalog.indexOf(opus47));
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("extractClaudeToolActivity summarizes Bash tool use", () => {
  const activity = extractClaudeToolActivity({
    message: {
      content: [
        {
          input: {
            command: "npm test -- --runInBand",
            description: "Run focused regression tests",
          },
          name: "Bash",
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    type: "assistant",
  });

  assert.equal(activity.name, "Bash");
  assert.equal(activity.status, "running");
  assert.match(activity.summary, /focused regression/);
  assert.match(activity.text, /npm test/);
});

test("extractClaudeToolActivity summarizes tool results", () => {
  const activity = extractClaudeToolActivity({
    message: {
      content: [
        {
          content: "line one\nline two",
          type: "tool_result",
        },
      ],
      role: "user",
    },
    toolUseResult: {
      stdout: "25 passed",
    },
    type: "user",
  });

  assert.equal(activity.status, "done");
  assert.match(activity.summary, /工具返回结果/);
  assert.match(activity.text, /25 passed/);
});
