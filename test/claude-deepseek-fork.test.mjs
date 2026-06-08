import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClaudePromptWithImages,
  buildDeepSeekSafeForkPrompt,
  ClaudeReadonlyBridge,
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

test("DeepSeek model selection does not pass a Claude --model alias", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-deepseek-no-alias-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sourceSessionId = "deepseek-no-alias-session";
  const fakeClaude = path.join(tempDir, "claude");
  const argsLog = path.join(tempDir, "args.log");
  const envLog = path.join(tempDir, "env.log");

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 claude-opus-4-7 deepseek-v4-pro[1m]\"",
      "  exit 0",
      "fi",
      `printf '%s\\n' "$@" >> '${argsLog.replaceAll("'", "'\\''")}'`,
      `printf '%s\\n' "$ANTHROPIC_MODEL" >> '${envLog.replaceAll("'", "'\\''")}'`,
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$input\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${input##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--resume\" ]; then session_id=\"$arg\"; fi",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}\\n' \"$session_id\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"deepseek-v4-pro\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    path.join(projectDir, `${sourceSessionId}.jsonl`),
    JSON.stringify({
      cwd: projectDir,
      message: { content: [{ text: "hello", type: "text" }], role: "user" },
      sessionId: sourceSessionId,
      timestamp: "2026-06-01T00:00:00.000Z",
      type: "user",
    }),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-pro[1m]";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-pro[1m]";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    const current = bridge.getProviderInfo(sourceSessionId).model.current;
    assert.equal(current.provider, "deepseek");
    assert.equal(current.model, "deepseek-v4-pro[1m]");

    await bridge.sendInput("use deepseek");

    const args = await readFile(argsLog, "utf-8");
    const env = await readFile(envLog, "utf-8");
    assert.doesNotMatch(args, /--model\nclaude-opus-4-7/);
    assert.doesNotMatch(args, /--model\nclaude-opus-4-8/);
    assert.match(env, /deepseek-v4-pro\[1m\]/);
  } finally {
    if (previousEnv.ANTHROPIC_MODEL == null) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousEnv.ANTHROPIC_MODEL;
    }
    if (previousEnv.CLAUDE2WEB_DEFAULT_MODEL == null) {
      delete process.env.CLAUDE2WEB_DEFAULT_MODEL;
    } else {
      process.env.CLAUDE2WEB_DEFAULT_MODEL = previousEnv.CLAUDE2WEB_DEFAULT_MODEL;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
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

test("extractClaudeToolActivity keeps background tasks running", () => {
  const activity = extractClaudeToolActivity({
    message: {
      content: [
        {
          content: "Command running in background with ID: bgf082sp8. Output is being written to: /private/tmp/claude-501/project/session/tasks/bgf082sp8.output. You will be notified when it completes.",
          type: "tool_result",
        },
      ],
      role: "user",
    },
    toolUseResult: {
      backgroundTaskId: "bgf082sp8",
      stderr: "",
      stdout: "",
    },
    type: "user",
  });

  assert.equal(activity.status, "background");
  assert.match(activity.summary, /bgf082sp8/);
  assert.match(activity.text, /后台任务/);
  assert.match(activity.text, /bgf082sp8\.output/);
});

test("Claude transcript history page can load entries older than the initial tail", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-history-page-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sessionId = "history-page-session";
  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
  const fakeClaude = path.join(tempDir, "claude");

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8\"",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);

  const records = [];
  for (let index = 1; index <= 380; index += 1) {
    records.push(
      JSON.stringify({
        cwd: projectDir,
        message: {
          content: [{ text: `history message ${index}`, type: "text" }],
          role: index % 2 === 0 ? "assistant" : "user",
        },
        sessionId,
        timestamp: `2026-06-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        type: index % 2 === 0 ? "assistant" : "user",
      }),
    );
  }
  await writeFile(sessionPath, records.join("\n"), "utf-8");

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    const snapshot = await bridge.getTranscriptSnapshot({ forceFull: true, sessionId });
    assert.equal(snapshot.entries.length, 300);
    assert.equal(snapshot.entries[0].text, "history message 81");

    const page = await bridge.getTranscriptHistoryPage({
      beforeId: snapshot.entries[0].id,
      limit: 25,
      sessionId,
    });

    assert.equal(page.entries.length, 25);
    assert.equal(page.entries[0].text, "history message 56");
    assert.equal(page.entries.at(-1).text, "history message 80");
    assert.equal(page.hasMore, true);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("Claude send completion preserves pending background task state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-background-task-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sourceSessionId = "background-task-session";
  const fakeClaude = path.join(tempDir, "claude");

  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 deepseek-v4-pro[1m]\"",
      "  exit 0",
      "fi",
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--resume\" ]; then session_id=\"$arg\"; fi",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "record='{ \"type\":\"user\", \"sessionId\":\"'\"$session_id\"'\", \"timestamp\":\"2026-06-01T00:00:02.000Z\", \"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"Command running in background with ID: bgf082sp8.\"}]}, \"toolUseResult\":{\"backgroundTaskId\":\"bgf082sp8\",\"stdout\":\"\",\"stderr\":\"\"} }'",
      `printf '%s\\n' "$record" >> '${projectDir.replaceAll("'", "'\\''")}/'\"$session_id\"'.jsonl'`,
      "printf '%s\\n' \"$record\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"deepseek-v4-pro[1m]\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    path.join(projectDir, `${sourceSessionId}.jsonl`),
    JSON.stringify({
      cwd: projectDir,
      message: { content: [{ text: "hello", type: "text" }], role: "user" },
      sessionId: sourceSessionId,
      timestamp: "2026-06-01T00:00:00.000Z",
      type: "user",
    }),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-pro[1m]";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-pro[1m]";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();
    await bridge.sendInput("run codex review");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.getTranscriptSnapshot({ forceFull: true, sessionId: sourceSessionId });

    const binding = bridge.getBinding(sourceSessionId);
    assert.equal(binding.send, "idle");
    assert.equal(binding.executionState.phase, "background");
    assert.match(binding.executionState.statusDetail, /后台任务仍在运行/);
    assert.equal(binding.executionState.lastToolActivity.status, "background");
  } finally {
    if (previousEnv.ANTHROPIC_MODEL == null) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousEnv.ANTHROPIC_MODEL;
    }
    if (previousEnv.CLAUDE2WEB_DEFAULT_MODEL == null) {
      delete process.env.CLAUDE2WEB_DEFAULT_MODEL;
    } else {
      process.env.CLAUDE2WEB_DEFAULT_MODEL = previousEnv.CLAUDE2WEB_DEFAULT_MODEL;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("Claude send launches from the session cwd so --resume can locate the conversation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-resume-cwd-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const siblingDir = path.join(sessionRoot, "jiaoya-app");
  const sourceSessionId = "launch-cwd-session";
  const sourceSessionPath = path.join(projectDir, `${sourceSessionId}.jsonl`);
  const fakeClaude = path.join(tempDir, "claude");
  const cwdLog = path.join(tempDir, "cwd.log");
  const pwdEnvLog = path.join(tempDir, "pwd-env.log");
  const argsLog = path.join(tempDir, "args.log");
  await mkdir(projectDir, { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(path.join(siblingDir, "OBJECT_MODEL.md"), "# model\n", "utf-8");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8\"",
      "  exit 0",
      "fi",
      `pwd > '${cwdLog.replaceAll("'", "'\\''")}'`,
      `printf '%s\\n' "$PWD" > '${pwdEnvLog.replaceAll("'", "'\\''")}'`,
      `printf '%s\\n' "$@" > '${argsLog.replaceAll("'", "'\\''")}'`,
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$input\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${input##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--resume\" ]; then session_id=\"$arg\"; fi",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}\\n' \"$session_id\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"claude-opus-4-8\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    sourceSessionPath,
    [
      JSON.stringify({
        cwd: projectDir,
        message: { content: [{ text: "hello", type: "text" }], role: "user" },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "user",
      }),
      JSON.stringify({
        cwd: projectDir,
        message: {
          content: [
            {
              text: `Edit sibling model at ${path.join(siblingDir, "OBJECT_MODEL.md")}`,
              type: "text",
            },
          ],
          role: "assistant",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:01.000Z",
        type: "assistant",
      }),
    ].join("\n"),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "claude-opus-4-8";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "claude-opus-4-8";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    const result = await bridge.sendInput("continue");
    assert.equal(result.sessionId, sourceSessionId);
    assert.equal((await readFile(cwdLog, "utf-8")).trim(), projectDir);
    assert.equal((await readFile(pwdEnvLog, "utf-8")).trim(), projectDir);

    const args = (await readFile(argsLog, "utf-8")).trim().split("\n");
    assert.equal(args.includes("--resume"), true);
    assert.equal(args[args.indexOf("--resume") + 1], sourceSessionId);
    assert.equal(args.includes("--add-dir"), true);
    assert.equal(args.includes(projectDir), true);
    assert.equal(args.includes(siblingDir), true);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("provider switch bridge applies only across providers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-provider-bridge-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sourceSessionId = "provider-bridge-session";
  const sourceSessionPath = path.join(projectDir, `${sourceSessionId}.jsonl`);
  const fakeClaude = path.join(tempDir, "claude");
  const promptLog = path.join(tempDir, "prompts.log");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 claude-sonnet-4-7 deepseek-v4-flash\"",
      "  exit 0",
      "fi",
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$input\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${input##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      `printf '%s\\n---PROMPT---\\n' \"$input\" >> '${promptLog.replaceAll("'", "'\\''")}'`,
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--resume\" ]; then session_id=\"$arg\"; fi",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:03.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}\\n' \"$session_id\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"test-model\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    sourceSessionPath,
    [
      JSON.stringify({
        cwd: tempDir,
        message: {
          content: [{ text: "DeepSeek阶段新增的关键事实：任务编号 T100，文件 src/example.js。", type: "text" }],
          role: "user",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "user",
      }),
      JSON.stringify({
        cwd: tempDir,
        message: {
          content: [{ text: "已记录 T100，下一步需要保持同一会话继续。", type: "text" }],
          role: "assistant",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:01.000Z",
        type: "assistant",
      }),
    ].join("\n"),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-flash";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-flash";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    await bridge.setModelSelection({ model: "claude-sonnet-4-7", provider: "claude" });
    const switchedResult = await bridge.sendInput("请继续");
    assert.equal(switchedResult.providerBridgeApplied, true);

    await bridge.setModelSelection({ model: "claude-opus-4-8", provider: "claude" });
    const sameProviderResult = await bridge.sendInput("同provider继续");
    assert.equal(sameProviderResult.providerBridgeApplied, false);

    const prompts = await readFile(promptLog, "utf-8");
    const promptParts = prompts.split("---PROMPT---").map((item) => item.trim()).filter(Boolean);
    assert.match(promptParts[0], /上下文恢复包/);
    assert.match(promptParts[0], /DeepSeek阶段新增的关键事实/);
    assert.doesNotMatch(promptParts[1], /上下文恢复包/);

    const logicalTranscriptPath = path.join(tempDir, "claude-logical-transcripts", `${sourceSessionId}.jsonl`);
    const logicalTranscript = await readFile(logicalTranscriptPath, "utf-8");
    assert.match(logicalTranscript, /"text":"请继续"/);
    assert.doesNotMatch(logicalTranscript, /上下文恢复包/);

    const visibleTranscript = await bridge.getTranscript(sourceSessionId);
    assert.ok(visibleTranscript.some((entry) => entry.role === "user" && entry.text === "请继续"));
    assert.ok(!visibleTranscript.some((entry) => entry.text.includes("上下文恢复包")));
  } finally {
    if (previousEnv.ANTHROPIC_MODEL == null) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousEnv.ANTHROPIC_MODEL;
    }
    if (previousEnv.CLAUDE2WEB_DEFAULT_MODEL == null) {
      delete process.env.CLAUDE2WEB_DEFAULT_MODEL;
    } else {
      process.env.CLAUDE2WEB_DEFAULT_MODEL = previousEnv.CLAUDE2WEB_DEFAULT_MODEL;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("model selection is shared by session and isolated across sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-session-model-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sessionA = "session-model-a";
  const sessionB = "session-model-b";
  const fakeClaude = path.join(tempDir, "claude");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 deepseek-v4-flash\"",
      "  exit 0",
      "fi",
      "input=$(cat)",
      "case \"$input\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${input##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "printf '{\"type\":\"result\",\"subtype\":\"success\"}\\n'",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);

  for (const sessionId of [sessionA, sessionB]) {
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        cwd: projectDir,
        message: { content: [{ text: `hello ${sessionId}`, type: "text" }], role: "user" },
        sessionId,
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "user",
      }),
      "utf-8",
    );
  }

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-flash";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-flash";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    assert.equal(bridge.getProviderInfo(sessionA).model.current.provider, "deepseek");
    assert.equal(bridge.getProviderInfo(sessionB).model.current.provider, "deepseek");

    await bridge.setModelSelection({ model: "claude-opus-4-8", provider: "claude", sessionId: sessionA });

    assert.equal(bridge.getProviderInfo(sessionA).model.current.model, "claude-opus-4-8");
    assert.equal(bridge.getBinding(sessionA).provider.model.current.model, "claude-opus-4-8");
    assert.equal(bridge.getProviderInfo(sessionB).model.current.model, "deepseek-v4-flash");

    const secondDeviceSameSession = bridge.getBinding(sessionA);
    assert.equal(secondDeviceSameSession.provider.model.current.model, "claude-opus-4-8");
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("DeepSeek safety execution keeps the pinned logical session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-hidden-fork-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sourceSessionId = "source-session-0001";
  const sourceSessionPath = path.join(projectDir, `${sourceSessionId}.jsonl`);
  const fakeClaude = path.join(tempDir, "claude");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 deepseek-v4-flash\"",
      "  exit 0",
      "fi",
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      `session_file='${projectDir.replaceAll("'", "'\\''")}/'\"$session_id\"'.jsonl'`,
      "printf '{\"type\":\"user\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:01.500Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"safe fork scaffold\"}]}}\\n' \"$session_id\" > \"$session_file\"",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK from hidden DeepSeek\"}]}}\\n' \"$session_id\" >> \"$session_file\"",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK from hidden DeepSeek\"}]}}\\n' \"$session_id\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"deepseek-v4-flash\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    sourceSessionPath,
    [
      JSON.stringify({
        cwd: tempDir,
        message: {
          content: [{ text: "hello", type: "text" }],
          role: "user",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "user",
      }),
      JSON.stringify({
        cwd: tempDir,
        message: {
          content: [{ thinking: "hidden", type: "thinking" }, { text: "visible", type: "text" }],
          role: "assistant",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:01.000Z",
        type: "assistant",
      }),
    ].join("\n"),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-flash";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-flash";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();
    const before = bridge.getBinding().pinnedSessionId;
    assert.equal(before, sourceSessionId);

    const result = await bridge.sendInput("continue with deepseek");
    assert.equal(result.forked, true);
    assert.equal(result.sessionId, sourceSessionId);
    assert.equal(bridge.getBinding().pinnedSessionId, sourceSessionId);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await bridge.getTranscriptSnapshot({ forceFull: true });
    assert.equal(bridge.getBinding().pinnedSessionId, sourceSessionId);
    const sessions = await bridge.discoverSessions();
    assert.equal(sessions.some((session) => /DeepSeek 安全分支/.test(session.name || "")), false);

    const restartedBridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit-after-restart.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await restartedBridge.init();
    assert.equal(restartedBridge.getBinding().pinnedSessionId, sourceSessionId);
    const restartedSnapshot = await restartedBridge.getTranscriptSnapshot({ forceFull: true });
    assert.equal(
      restartedSnapshot.entries.some((entry) => entry.role === "user" && entry.text === "continue with deepseek"),
      true,
    );
    assert.equal(
      restartedSnapshot.entries.some((entry) => entry.role === "assistant" && entry.text === "OK from hidden DeepSeek"),
      true,
    );
  } finally {
    if (previousEnv.ANTHROPIC_MODEL == null) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousEnv.ANTHROPIC_MODEL;
    }
    if (previousEnv.CLAUDE2WEB_DEFAULT_MODEL == null) {
      delete process.env.CLAUDE2WEB_DEFAULT_MODEL;
    } else {
      process.env.CLAUDE2WEB_DEFAULT_MODEL = previousEnv.CLAUDE2WEB_DEFAULT_MODEL;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("DeepSeek safety execution reuses a ready hidden run for consecutive DeepSeek sends", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-deepseek-reuse-"));
  const sessionRoot = path.join(tempDir, "projects");
  const projectDir = path.join(sessionRoot, "project");
  const sourceSessionId = "reuse-source-session";
  const sourceSessionPath = path.join(projectDir, `${sourceSessionId}.jsonl`);
  const fakeClaude = path.join(tempDir, "claude");
  const promptLog = path.join(tempDir, "prompts.log");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-p\" ] && [ \"$2\" = \"--help\" ]; then",
      "  echo \"--model claude-opus-4-8 deepseek-v4-flash\"",
      "  exit 0",
      "fi",
      "input=$(cat)",
      "prompt=\"$input\"",
      "for arg in \"$@\"; do prompt=\"$arg\"; done",
      "case \"$prompt\" in",
      "  *Reply\\ exactly:*)",
      "    printf '%s\\n' \"${prompt##*Reply exactly: }\"",
      "    exit 0",
      "    ;;",
      "esac",
      `printf '%s\\n---PROMPT---\\n' \"$input\" >> '${promptLog.replaceAll("'", "'\\''")}'`,
      "session_id=\"\"",
      "prev=\"\"",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = \"--session-id\" ]; then session_id=\"$arg\"; fi",
      "  if [ \"$prev\" = \"--resume\" ]; then session_id=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      `session_file='${projectDir.replaceAll("'", "'\\''")}/'\"$session_id\"'.jsonl'`,
      "[ -f \"$session_file\" ] || : > \"$session_file\"",
      "printf '{\"type\":\"user\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:01.500Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"%s\"}]}}\\n' \"$session_id\" \"$(printf '%s' \"$input\" | sed 's/\"/\\\\\"/g')\" >> \"$session_file\"",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK from %s\"}]}}\\n' \"$session_id\" \"$session_id\" >> \"$session_file\"",
      "printf '{\"type\":\"assistant\",\"sessionId\":\"%s\",\"timestamp\":\"2026-06-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}\\n' \"$session_id\"",
      "printf '{\"type\":\"result\",\"sessionId\":\"%s\",\"subtype\":\"success\",\"modelUsage\":{\"deepseek-v4-flash\":{\"inputTokens\":1,\"outputTokens\":1}}}\\n' \"$session_id\"",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    sourceSessionPath,
    [
      JSON.stringify({
        cwd: tempDir,
        message: { content: [{ text: "hello", type: "text" }], role: "user" },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "user",
      }),
      JSON.stringify({
        cwd: tempDir,
        message: {
          content: [{ thinking: "hidden", type: "thinking" }, { text: "visible", type: "text" }],
          role: "assistant",
        },
        sessionId: sourceSessionId,
        timestamp: "2026-06-01T00:00:01.000Z",
        type: "assistant",
      }),
    ].join("\n"),
    "utf-8",
  );

  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE2WEB_DEFAULT_MODEL: process.env.CLAUDE2WEB_DEFAULT_MODEL,
  };
  process.env.ANTHROPIC_MODEL = "deepseek-v4-flash";
  process.env.CLAUDE2WEB_DEFAULT_MODEL = "deepseek-v4-flash";

  try {
    const bridge = new ClaudeReadonlyBridge({
      auditFilePath: path.join(tempDir, "audit.jsonl"),
      claudeBinaryPath: fakeClaude,
      sendRequested: true,
      sessionRootPath: sessionRoot,
      stateFilePath: path.join(tempDir, "state.json"),
    });
    await bridge.init();

    const first = await bridge.sendInput("first deepseek");
    assert.equal(first.forked, true);
    assert.equal(first.reusedDeepSeekRun, false);

    const second = await bridge.sendInput("second deepseek");
    assert.equal(second.forked, false);
    assert.equal(second.reusedDeepSeekRun, true);
    assert.equal(second.sessionId, sourceSessionId);

    const prompts = await readFile(promptLog, "utf-8");
    const promptParts = prompts.split("---PROMPT---").map((item) => item.trim()).filter(Boolean);
    assert.equal(promptParts.length, 2);
    assert.match(promptParts[0], /这是一个自动创建的 DeepSeek 安全分支/);
    assert.doesNotMatch(promptParts[1], /这是一个自动创建的 DeepSeek 安全分支/);
    assert.match(promptParts[1], /^second deepseek$/);
  } finally {
    if (previousEnv.ANTHROPIC_MODEL == null) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousEnv.ANTHROPIC_MODEL;
    }
    if (previousEnv.CLAUDE2WEB_DEFAULT_MODEL == null) {
      delete process.env.CLAUDE2WEB_DEFAULT_MODEL;
    } else {
      process.env.CLAUDE2WEB_DEFAULT_MODEL = previousEnv.CLAUDE2WEB_DEFAULT_MODEL;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});
