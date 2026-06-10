import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { BridgeError } from "../local-bridge.js";

const DEFAULT_CLAUDE_BINARY = "claude";
const DEFAULT_CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_TRANSCRIPT_LIMIT = 300;
const HISTORY_TRANSCRIPT_LIMIT = 3000;
const TRANSCRIPT_TAIL_INITIAL_READ_BYTES = 512 * 1024;
const TRANSCRIPT_TAIL_MAX_READ_BYTES = 24 * 1024 * 1024;
const SEND_ACCEPT_TIMEOUT_MS = 1500;
const SEND_PROBE_TIMEOUT_MS = readPositiveDuration(process.env.CLAUDE2WEB_SEND_PROBE_TIMEOUT_MS, 90000);
const SEND_READINESS_RETRY_MS = readPositiveDuration(process.env.CLAUDE2WEB_SEND_READINESS_RETRY_MS, 60000);
const SEND_TIMEOUT_MS = 600000;
const SESSION_POLL_INTERVAL_MS = 1200;
const SESSION_REFRESH_TTL_MS = 5000;
const STOP_ESCALATION_TIMEOUT_MS = 3000;
const RECENT_TRANSCRIPT_ADD_DIR_LIMIT = 8;
const DEEPSEEK_FORK_CONTEXT_LIMIT = 12;
const PROVIDER_BRIDGE_RECENT_ENTRY_LIMIT = 8;
const PROVIDER_BRIDGE_CHAR_BUDGET = 6000;
const PROVIDER_BRIDGE_OPUS_CHAR_BUDGET = 4200;
const EXECUTION_STALL_WATCHDOG_INTERVAL_MS = readPositiveDuration(
  process.env.CODEX2WEB_STALL_WATCHDOG_INTERVAL_MS,
  5000,
);
const EXECUTION_VISIBLE_OUTPUT_STALL_MS = readPositiveDuration(
  process.env.CODEX2WEB_VISIBLE_OUTPUT_STALL_MS,
  10 * 60 * 1000,
);
const EXECUTION_MAX_RUNTIME_MS = readPositiveDuration(
  process.env.CODEX2WEB_MAX_EXECUTION_MS,
  45 * 60 * 1000,
);
const MODEL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
];
const CLAUDE_USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const CLAUDE_DESKTOP_ROOT = path.join(os.homedir(), "Library", "Application Support", "Claude");
const CLAUDE_DESKTOP_CODE_SESSIONS_ROOT = path.join(CLAUDE_DESKTOP_ROOT, "claude-code-sessions");
const CLAUDE_DESKTOP_LOCAL_AGENT_SESSIONS_ROOT = path.join(CLAUDE_DESKTOP_ROOT, "local-agent-mode-sessions");
const CLAUDE_DESKTOP_CHANGELOG_PATH = path.join(os.homedir(), ".claude", "cache", "changelog.md");
const DEEPSEEK_MODEL_ENV = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "",
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "deepseek-v4-flash",
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "deepseek-v4-pro[1m]",
  ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "deepseek-v4-pro[1m]",
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "deepseek-v4-pro[1m]",
  CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL || "max",
  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || "deepseek-v4-flash",
};

function nowIso() {
  return new Date().toISOString();
}

function readPositiveDuration(value, fallbackMs) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(value) {
  const trimmed = trimText(value);
  if (!trimmed) {
    return "";
  }

  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function isPathInside(childPath, parentPath) {
  const child = normalizePath(childPath);
  const parent = normalizePath(parentPath);
  if (!child || !parent) {
    return false;
  }
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function extractAbsolutePathsFromString(value) {
  const text = trimText(value);
  if (!/(?:\/Users\/|\/Volumes\/|\/private\/var\/|\/var\/|\/tmp\/)/.test(text)) {
    return [];
  }

  return Array.from(text.matchAll(/(?:\/Users|\/Volumes|\/private\/var|\/var|\/tmp)\/[^\n\r"'<>`]+/g))
    .map((match) => normalizePath(match[0]
      .replace(/:\d+$/g, "")
      .replace(/[),.;，。；、\]}]+$/g, "")))
    .filter(Boolean);
}

function collectAbsolutePathsFromValue(value, paths, depth = 0) {
  if (depth > 6 || value == null) {
    return;
  }

  if (typeof value === "string") {
    for (const filePath of extractAbsolutePathsFromString(value)) {
      paths.add(filePath);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAbsolutePathsFromValue(item, paths, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      collectAbsolutePathsFromValue(item, paths, depth + 1);
    }
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRootForPath(filePath, boundaryPath) {
  const normalized = normalizePath(filePath);
  const boundary = normalizePath(boundaryPath);
  if (!normalized || !boundary || !isPathInside(normalized, boundary)) {
    return "";
  }

  let current = normalized;
  try {
    const info = await stat(current);
    if (!info.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.extname(current) ? path.dirname(current) : current;
  }

  while (isPathInside(current, boundary)) {
    const markerChecks = [
      path.join(current, ".git"),
      path.join(current, "package.json"),
      path.join(current, "pnpm-workspace.yaml"),
      path.join(current, "PRD.md"),
      path.join(current, "OBJECT_MODEL.md"),
    ];
    for (const marker of markerChecks) {
      if (await pathExists(marker)) {
        return current;
      }
    }

    if (current === boundary) {
      break;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }

  return "";
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function safeFileName(value) {
  return trimText(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function listFilesRecursive(rootPath, { extensions = new Set(), limit = 1200 } = {}) {
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && (extensions.size === 0 || extensions.has(path.extname(entry.name)))) {
        files.push(entryPath);
        if (files.length >= limit) {
          break;
        }
      }
    }
  }

  return files;
}

function normalizeModelName(value) {
  return trimText(value).replace(/\s+/g, " ");
}

function isSafeModelName(value) {
  const model = normalizeModelName(value);
  return model.length > 0 && model.length <= 160 && !/[\u0000-\u001f\u007f]/.test(model);
}

function inferModelProvider(model, fallback = "") {
  const lower = normalizeModelName(model).toLowerCase();
  const requested = normalizeModelName(fallback).toLowerCase();
  if (requested === "claude" || requested === "deepseek") {
    return requested;
  }
  if (lower.includes("deepseek")) {
    return "deepseek";
  }
  return "claude";
}

function formatClaudeModelDisplayName(model) {
  const normalized = normalizeModelName(model).toLowerCase();
  const alias = {
    haiku: "Haiku",
    opus: "Opus",
    sonnet: "Sonnet",
  }[normalized];
  if (alias) {
    return alias;
  }

  const match = normalized.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?(?:\[\d+m\])?$/);
  if (!match) {
    return `Claude: ${model}`;
  }

  const family = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  return `${family} ${match[2]}.${match[3]}`;
}

function parseClaudeOfficialModel(model) {
  const normalized = normalizeModelName(model).toLowerCase();
  const match = normalized.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?(?:\[\d+m\])?$/);
  if (!match) {
    return null;
  }

  return {
    family: match[1],
    major: Number(match[2]),
    minor: Number(match[3]),
    versionScore: Number(match[2]) * 1000 + Number(match[3]),
  };
}

function withLegacyLabel(option) {
  return {
    ...option,
    label: `${option.label} Legacy`,
  };
}

function formatModelDisplayName(model, provider) {
  if (provider === "deepseek") {
    return `DeepSeek: ${model}`;
  }
  return formatClaudeModelDisplayName(model);
}

function getDeepSeekClaudeCliAlias(model) {
  const normalized = normalizeModelName(model).toLowerCase();
  if (normalized.includes("flash")) {
    return "claude-haiku-4-5";
  }
  return "claude-opus-4-7";
}

function modelOption({ model, provider, source }) {
  const normalizedModel = normalizeModelName(model);
  const normalizedProvider = inferModelProvider(normalizedModel, provider);
  return {
    cliModel: normalizedProvider === "deepseek" ? "" : normalizedModel,
    id: `${normalizedProvider}:${normalizedModel}`,
    label: formatModelDisplayName(normalizedModel, normalizedProvider),
    model: normalizedModel,
    provider: normalizedProvider,
    source,
  };
}

function addModelOption(target, option) {
  if (!option?.model || !isSafeModelName(option.model)) {
    return;
  }

  if (!looksLikeModelName(option.model)) {
    return;
  }

  const key = `${option.provider}:${option.model}`.toLowerCase();
  if (target.has(key)) {
    const previous = target.get(key);
    target.set(key, {
      ...previous,
      source: Array.from(
        new Set(
          String(previous.source || "")
            .split(",")
            .concat(String(option.source || "").split(","))
            .map((source) => source.trim())
            .filter(Boolean),
        ),
      ).join(","),
    });
    return;
  }

  target.set(key, option);
}

function looksLikeModelName(value) {
  const model = normalizeModelName(value).toLowerCase();
  if (!model) {
    return false;
  }
  if (model === "opus" || model === "sonnet" || model === "haiku") {
    return true;
  }
  if (model.includes("deepseek")) {
    return true;
  }
  return /^claude-(opus|sonnet|haiku)-\d+-\d+(?:-\d{8})?(?:\[\d+m\])?$/.test(model);
}

function collectClaudeModelsFromConfig(value, target, pathParts = []) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    const sourcePath = pathParts.join(".");
    const pathCanContainModels = /model|lastModelUsage/i.test(sourcePath);
    for (const item of value) {
      if (pathCanContainModels && typeof item === "string" && isSafeModelName(item) && /claude|sonnet|opus|haiku/i.test(item)) {
        addModelOption(target, modelOption({ model: item, provider: "claude", source: sourcePath || "claude-config" }));
      }
      if (item && typeof item === "object") {
        collectClaudeModelsFromConfig(item, target, pathParts);
      }
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (typeof item === "string" && isSafeModelName(item) && /model/i.test(key) && !/deepseek/i.test(item)) {
      addModelOption(target, modelOption({ model: item, provider: "claude", source: nextPath.join(".") }));
      continue;
    }

    if (key === "lastModelUsage" && item && typeof item === "object") {
      for (const model of Object.keys(item)) {
        if (/claude|sonnet|opus|haiku/i.test(model) && !/deepseek/i.test(model)) {
          addModelOption(target, modelOption({ model, provider: "claude", source: nextPath.join(".") }));
        }
      }
      continue;
    }

    collectClaudeModelsFromConfig(item, target, nextPath);
  }
}

async function collectClaudeDesktopSessionModels(target) {
  const files = [
    ...(await listFilesRecursive(CLAUDE_DESKTOP_CODE_SESSIONS_ROOT, {
      extensions: new Set([".json"]),
      limit: 400,
    })),
    ...(await listFilesRecursive(CLAUDE_DESKTOP_LOCAL_AGENT_SESSIONS_ROOT, {
      extensions: new Set([".json"]),
      limit: 400,
    })),
  ];

  for (const filePath of files) {
    const parsed = await readJsonFile(filePath);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const model = normalizeModelName(parsed.model || parsed.selectedModel || parsed.defaultModel);
    if (model && !/deepseek/i.test(model)) {
      addModelOption(target, modelOption({ model, provider: "claude", source: "claude-desktop-session" }));
    }
  }
}

async function collectClaudeModelsFromChangelog(target) {
  let changelog = "";
  try {
    changelog = await readFile(CLAUDE_DESKTOP_CHANGELOG_PATH, "utf-8");
  } catch {
    return;
  }

  const matches = changelog.matchAll(/\b(Opus|Sonnet|Haiku)\s+(\d+)\.(\d+)\b/g);
  for (const match of matches) {
    const family = match[1].toLowerCase();
    const model = `claude-${family}-${match[2]}-${match[3]}`;
    addModelOption(target, modelOption({ model, provider: "claude", source: "claude-changelog" }));
  }
}

async function collectClaudeModelsFromCliHelp(target, binaryPath = DEFAULT_CLAUDE_BINARY) {
  const result = await runClaudeCommand({
    args: ["-p", "--help"],
    binaryPath,
    cwd: os.tmpdir(),
    timeoutMs: 10000,
  });
  if (result.error || result.code !== 0) {
    return;
  }

  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const matches = text.matchAll(/\bclaude-(opus|sonnet|haiku)-\d+-\d+(?:-\d{8})?(?:\[\d+m\])?\b/gi);
  for (const match of matches) {
    addModelOption(target, modelOption({ model: match[0], provider: "claude", source: "claude-cli-help" }));
  }
}

function buildDeepSeekModelOptions() {
  const candidates = [
    DEEPSEEK_MODEL_ENV.ANTHROPIC_MODEL,
    DEEPSEEK_MODEL_ENV.ANTHROPIC_DEFAULT_OPUS_MODEL,
    DEEPSEEK_MODEL_ENV.ANTHROPIC_DEFAULT_SONNET_MODEL,
    DEEPSEEK_MODEL_ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    DEEPSEEK_MODEL_ENV.CLAUDE_CODE_SUBAGENT_MODEL,
  ];
  const byKey = new Map();
  for (const model of candidates) {
    addModelOption(byKey, modelOption({ model, provider: "deepseek", source: "runtime-env" }));
  }
  return Array.from(byKey.values());
}

export async function discoverDynamicModelCatalog({ claudeBinaryPath = DEFAULT_CLAUDE_BINARY } = {}) {
  const byKey = new Map();
  for (const option of buildDeepSeekModelOptions()) {
    addModelOption(byKey, option);
  }

  const userSettings = await readJsonFile(CLAUDE_USER_SETTINGS_PATH);
  if (isSafeModelName(userSettings?.model) && !/deepseek/i.test(userSettings.model) && !isClaudeAlias(userSettings.model)) {
    addModelOption(byKey, modelOption({ model: userSettings.model, provider: "claude", source: "claude-settings" }));
  }

  const globalConfig = await readJsonFile(CLAUDE_GLOBAL_CONFIG_PATH);
  collectClaudeModelsFromConfig(globalConfig, byKey, []);
  await collectClaudeDesktopSessionModels(byKey);
  await collectClaudeModelsFromChangelog(byKey);
  await collectClaudeModelsFromCliHelp(byKey, claudeBinaryPath);

  return pruneModelCatalog(Array.from(byKey.values())).sort((left, right) => {
    if (left.provider !== right.provider) {
      return left.provider === "deepseek" ? -1 : 1;
    }
    return modelSortRank(left) - modelSortRank(right) || left.label.localeCompare(right.label);
  });
}

function pruneModelCatalog(options) {
  const deepseekOptions = options.filter((option) => option.provider === "deepseek");
  const officialOptions = options
    .filter((option) => option.provider === "claude" && parseClaudeOfficialModel(option.model))
    .sort((left, right) => {
      const leftModel = parseClaudeOfficialModel(left.model);
      const rightModel = parseClaudeOfficialModel(right.model);
      return rightModel.versionScore - leftModel.versionScore || left.model.localeCompare(right.model);
    });

  const selected = [];
  for (const family of ["opus", "sonnet", "haiku"]) {
    const familyOptions = officialOptions.filter((option) => parseClaudeOfficialModel(option.model)?.family === family);
    if (familyOptions[0]) {
      selected.push(familyOptions[0]);
    }
    if (family === "opus" && familyOptions[1]) {
      selected.push(withLegacyLabel(familyOptions[1]));
    }
  }

  const byKey = new Map();
  for (const option of [...deepseekOptions, ...selected]) {
    addModelOption(byKey, option);
  }
  return Array.from(byKey.values());
}

function isClaudeAlias(value) {
  return ["opus", "sonnet", "haiku"].includes(normalizeModelName(value).toLowerCase());
}

function modelSortRank(option) {
  if (option.provider === "deepseek") {
    return option.model.includes("pro") ? 0 : 1;
  }

  const lower = option.model.toLowerCase();
  if (lower === "opus" || lower.includes("opus-4-8")) return 10;
  if (lower.includes("opus-4-7")) return 11;
  if (lower === "sonnet" || lower.includes("sonnet-4-6")) return 12;
  if (lower === "haiku" || lower.includes("haiku-4-5")) return 13;
  if (lower.includes("opus-4-6")) return 14;
  return 30;
}

export function resolveModelSelection(catalog, request = {}) {
  const requestObject = request && typeof request === "object" ? request : {};
  const requestedProvider = normalizeModelName(requestObject.provider).toLowerCase();
  const requestedModel = normalizeModelName(
    requestObject.model || requestObject.id || (typeof request === "string" ? request : "") || requestObject.cliModel,
  );
  const key = requestedModel.toLowerCase();

  if (key) {
    const scopedCatalog = requestedProvider
      ? catalog.filter((option) => option.provider.toLowerCase() === requestedProvider)
      : catalog;
    const exactMatched = scopedCatalog.find((option) => (
      option.id.toLowerCase() === key ||
      option.model.toLowerCase() === key ||
      option.label.toLowerCase() === key
    ));
    if (exactMatched) {
      return exactMatched;
    }

    const matched = scopedCatalog.find((option) => option.cliModel.toLowerCase() === key);
    if (matched) {
      return matched;
    }
  }

  if (isSafeModelName(requestedModel)) {
    return modelOption({
      model: requestedModel,
      provider: inferModelProvider(requestedModel, requestedProvider),
      source: "custom",
    });
  }

  return null;
}

function createClaudeExecutionEnv(selection, cwd = "") {
  const nextEnv = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  };
  const normalizedCwd = normalizePath(cwd);
  if (normalizedCwd) {
    nextEnv.PWD = normalizedCwd;
  }

  for (const key of MODEL_ENV_KEYS) {
    delete nextEnv[key];
  }

  if (selection?.provider === "deepseek") {
    for (const [key, value] of Object.entries(DEEPSEEK_MODEL_ENV)) {
      if (value) {
        nextEnv[key] = value;
      }
    }
    if (selection.model) {
      nextEnv.ANTHROPIC_MODEL = selection.model;
    }
  }

  return nextEnv;
}

function formatModelList(catalog, currentSelection) {
  const rows = catalog.map((option) => {
    const marker = option.id === currentSelection.id ? "*" : "-";
    return `${marker} ${option.model} (${option.provider}, ${option.source})`;
  });

  return [
    `当前模型：${currentSelection.model} (${currentSelection.provider})`,
    "动态发现的模型：",
    ...rows,
    "",
    "切换用法：/model <模型名>",
    "也可以在页面底部的模型输入框里选择或输入 Claude CLI 支持的完整模型名。",
  ].join("\n");
}

function parseModelCommand(input) {
  const trimmed = trimText(input);
  if (!/^\/model(?:\s|$)/i.test(trimmed)) {
    return null;
  }

  const requested = trimText(trimmed.replace(/^\/model/i, ""));
  return { requested };
}

function basename(input) {
  return String(input || "").split(/[\\/]/).filter(Boolean).pop() || "unknown";
}

function extractClaudeContentText(content) {
  if (typeof content === "string") {
    return trimText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      const text = trimText(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n\n").trim();
}

function truncateToolText(value, limit = 900) {
  const text = trimText(value).replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") {
    return "";
  }

  const toolName = trimText(name);
  if (toolName === "Bash") {
    return truncateToolText(input.description || input.command || "");
  }
  if (toolName === "Read") {
    return truncateToolText(input.file_path || "");
  }
  if (toolName === "Glob") {
    return truncateToolText([input.pattern, input.path].filter(Boolean).join(" · "));
  }
  if (toolName === "Grep") {
    return truncateToolText([input.pattern, input.path].filter(Boolean).join(" · "));
  }
  if (toolName === "WebFetch") {
    return truncateToolText(input.url || input.prompt || "");
  }

  const compact = JSON.stringify(input);
  return truncateToolText(compact || "");
}

function summarizeToolResult(record, block) {
  const result = record?.toolUseResult && typeof record.toolUseResult === "object" ? record.toolUseResult : {};
  if (result.backgroundTaskId) {
    const taskId = trimText(result.backgroundTaskId);
    const content = typeof block?.content === "string" ? block.content : "";
    const outputFile = trimText(
      result.outputFile
        || result.output_file
        || content.match(/Output is being written to:\s*(\S+?\.output)\b/)?.[1]
        || "",
    );
    return truncateToolText(
      [
        `后台任务 ${taskId} 正在运行。`,
        outputFile ? `输出文件：${outputFile}` : "",
        "Claude CLI 会在任务完成后追加通知；完成前不能视为本轮任务完整结束。",
      ].filter(Boolean).join("\n"),
    );
  }
  const content = typeof block?.content === "string" ? block.content : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const error = typeof result.error === "string" ? result.error : "";
  const source = error || stderr || stdout || content;
  return truncateToolText(source || "工具已返回结果。");
}

export function extractClaudeToolActivity(record) {
  const role = record?.message?.role || record?.type;
  const content = record?.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  if (role === "assistant") {
    const block = content.find((item) => item && typeof item === "object" && item.type === "tool_use");
    if (!block) {
      return null;
    }
    const name = trimText(block.name) || "工具";
    const summary = summarizeToolInput(name, block.input);
    const command = name === "Bash" ? truncateToolText(block.input?.command || "", 1200) : "";
    return {
      detail: command,
      name,
      status: "running",
      summary: summary || `正在执行 ${name}`,
      text: [
        `正在执行工具：${name}`,
        summary ? `检查内容：${summary}` : "",
        command ? `命令：\n\`\`\`bash\n${command}\n\`\`\`` : "",
      ].filter(Boolean).join("\n\n"),
    };
  }

  if (role === "user") {
    const block = content.find((item) => item && typeof item === "object" && item.type === "tool_result");
    if (!block) {
      return null;
    }
    const isError = Boolean(block.is_error || record?.toolUseResult?.is_error);
    const backgroundTaskId = trimText(record?.toolUseResult?.backgroundTaskId || "");
    const summary = summarizeToolResult(record, block);
    return {
      detail: summary,
      name: "工具",
      status: backgroundTaskId ? "background" : isError ? "error" : "done",
      summary: backgroundTaskId ? `后台任务 ${backgroundTaskId} 正在运行` : isError ? "工具返回错误" : "工具返回结果",
      text: [
        backgroundTaskId ? "后台任务运行中" : isError ? "工具返回错误" : "工具返回结果",
        summary ? `结果摘要：\n\`\`\`text\n${summary}\n\`\`\`` : "",
      ].filter(Boolean).join("\n\n"),
    };
  }

  return null;
}

function formatTranscriptRole(role) {
  return role === "assistant" ? "Assistant" : "User";
}

function getProviderBridgeBudget(selection) {
  const model = normalizeModelName(selection?.model).toLowerCase();
  if (selection?.provider === "claude" && model.includes("opus")) {
    return PROVIDER_BRIDGE_OPUS_CHAR_BUDGET;
  }
  return PROVIDER_BRIDGE_CHAR_BUDGET;
}

function buildProviderSwitchBridgePrompt({ bridge, prompt, selection, transcript }) {
  const cleanPrompt = trimText(prompt);
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
    .filter((entry) => trimText(entry?.text))
    .filter((entry) => !isDeepSeekSafeForkScaffoldText(entry.text))
    .slice(-PROVIDER_BRIDGE_RECENT_ENTRY_LIMIT);

  if (!bridge || entries.length === 0) {
    return cleanPrompt;
  }

  const budget = getProviderBridgeBudget(selection);
  let remaining = budget;
  const context = [];
  for (const entry of entries.reverse()) {
    const role = formatTranscriptRole(entry.role);
    const header = `${role} (${entry.time || "unknown time"}):`;
    const textBudget = Math.max(280, remaining - header.length - 32);
    const text = trimText(entry.text).slice(0, textBudget);
    if (!text) {
      continue;
    }
    const block = `${header}\n${text}`;
    context.unshift(block);
    remaining -= block.length;
    if (remaining <= 0) {
      break;
    }
  }

  if (context.length === 0) {
    return cleanPrompt;
  }

  return [
    "以下是同一个 Claude2Web 可见会话在跨 provider 切换后带入的最近上下文恢复包。",
    `切换方向：${bridge.fromProvider || "unknown"} -> ${bridge.toProvider || selection?.provider || "unknown"}`,
    "注意：这不是新的用户请求，只用于恢复上下文；如与当前用户请求冲突，以当前用户请求为准。",
    "",
    "最近可见上下文：",
    context.join("\n\n"),
    "",
    "当前用户请求：",
    cleanPrompt,
  ].join("\n");
}

function isDeepSeekSafeForkScaffoldText(text) {
  const value = trimText(text);
  return value.startsWith("这是一个自动创建的 DeepSeek 安全分支。");
}

function isInternalProviderScaffoldText(text) {
  const value = trimText(text);
  return isDeepSeekSafeForkScaffoldText(value)
    || value.startsWith("以下是同一个 Claude2Web 可见会话在跨 provider 切换后带入的最近上下文恢复包。");
}

function isDeepSeekSafeForkSession(session) {
  return isDeepSeekSafeForkScaffoldText(session?.name || "");
}

export function buildDeepSeekSafeForkPrompt({ latestPrompt, sourceSessionId, transcript }) {
  const recentEntries = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => trimText(entry?.text))
    .filter((entry) => !isDeepSeekSafeForkScaffoldText(entry.text))
    .slice(-DEEPSEEK_FORK_CONTEXT_LIMIT);
  const context = recentEntries.length > 0
    ? recentEntries
        .map((entry, index) => {
          const text = trimText(entry.text).slice(0, 4000);
          return `${index + 1}. ${formatTranscriptRole(entry.role)} (${entry.time || "unknown time"}):\n${text}`;
        })
        .join("\n\n")
    : "无可见历史上下文。";

  return [
    "这是一个自动创建的 DeepSeek 安全分支。",
    `来源 Claude session: ${sourceSessionId || "unknown"}`,
    "",
    "背景：原 session 包含 Claude thinking 历史，DeepSeek Anthropic 兼容接口不能直接 resume。下面提供最近可见对话上下文，请基于这些上下文继续处理用户最新请求。",
    "",
    "最近可见上下文：",
    context,
    "",
    "用户最新请求：",
    trimText(latestPrompt),
  ].join("\n");
}

function claudeContentHasThinking(content) {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return block.type === "thinking" || Object.hasOwn(block, "thinking");
  });
}

function claudeRecordHasThinking(record) {
  return claudeContentHasThinking(record?.message?.content) || claudeContentHasThinking(record?.content);
}

function normalizeClaudeRecord(sessionId, record, lineNumber) {
  if (record?.isSidechain === true) {
    return null;
  }

  const role = record?.message?.role || record?.type;
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  if (record?.type !== "user" && record?.type !== "assistant") {
    return null;
  }

  const toolActivity = extractClaudeToolActivity(record);
  if (toolActivity) {
    return {
      id: `${sessionId}:tool:${lineNumber}`,
      role: "tool",
      text: toolActivity.text,
      time: record.timestamp || nowIso(),
      toolActivity,
    };
  }

  const text = extractClaudeContentText(record.message?.content);
  if (!text) {
    return null;
  }

  return {
    id: `${sessionId}:${role}:${lineNumber}`,
    role,
    text,
    time: record.timestamp || nowIso(),
  };
}

function namespaceLogicalBranchEntryId(entry, sourceSessionId) {
  if (!entry?.id || !sourceSessionId) {
    return entry;
  }

  const parts = String(entry.id).split(":");
  if (parts.length < 3) {
    return entry;
  }

  const [logicalSessionId, ...rest] = parts;
  return {
    ...entry,
    id: `${logicalSessionId}:branch:${sourceSessionId}:${rest.join(":")}`,
  };
}

function transcriptContentKey(entry) {
  if (!entry) {
    return "";
  }
  return [
    trimText(entry.role),
    trimText(entry.time),
    trimText(entry.text),
  ].join("\u0000");
}

async function listJsonlFiles(rootPath) {
  const files = [];
  let entries = [];

  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory() && entry.name === "subagents") {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function isSubagentTranscriptFile(filePath) {
  return filePath.split(path.sep).includes("subagents");
}

async function readJsonlSlice(filePath, offset, length) {
  if (length <= 0) {
    return "";
  }

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function readTranscriptTail(filePath, fileSize, minimumLineCount = DEFAULT_TRANSCRIPT_LIMIT * 3) {
  const maxReadBytes = Math.min(fileSize, TRANSCRIPT_TAIL_MAX_READ_BYTES);
  let readBytes = Math.min(fileSize, TRANSCRIPT_TAIL_INITIAL_READ_BYTES);

  while (readBytes <= maxReadBytes) {
    const offset = Math.max(0, fileSize - readBytes);
    const raw = await readJsonlSlice(filePath, offset, fileSize - offset);
    const lines = raw.split("\n").filter((line) => line.trim());
    if (offset === 0 || lines.length >= minimumLineCount || readBytes >= maxReadBytes) {
      return { offset, raw };
    }

    readBytes = Math.min(maxReadBytes, readBytes * 2);
  }

  return { offset: 0, raw: "" };
}

async function inferRecentTranscriptReadableDirs(session) {
  if (!session?.filePath || !session?.projectPath) {
    return [];
  }

  const boundaryPath = path.dirname(session.projectPath);
  const paths = new Set();
  try {
    const fileInfo = await stat(session.filePath);
    const { raw } = await readTranscriptTail(session.filePath, fileInfo.size);
    const lines = raw.split("\n").filter((line) => line.trim()).slice(-120);
    for (const line of lines) {
      const parsed = safeJsonParse(line);
      if (!parsed) {
        continue;
      }
      collectAbsolutePathsFromValue(parsed, paths);
    }
  } catch {
    return [];
  }

  const dirs = [];
  for (const filePath of paths) {
    if (dirs.length >= RECENT_TRANSCRIPT_ADD_DIR_LIMIT) {
      break;
    }
    const workspaceRoot = await findWorkspaceRootForPath(filePath, boundaryPath);
    if (workspaceRoot && workspaceRoot !== session.projectPath && !dirs.includes(workspaceRoot)) {
      dirs.push(workspaceRoot);
    }
  }

  return dirs;
}

async function readClaudeSessionMetadata(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const fallbackId = path.basename(filePath, ".jsonl");
  let id = fallbackId;
  let currentPath = "";
  let resumePath = "";
  let updatedAt = "";
  let firstUserText = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse(line);
    if (!parsed) {
      continue;
    }

    id = trimText(parsed.sessionId) || id;
    const recordCwd = normalizePath(parsed.cwd);
    if (recordCwd) {
      if (!resumePath) {
        resumePath = recordCwd;
      }
      currentPath = recordCwd;
    }
    updatedAt = parsed.timestamp || updatedAt;

    if (!firstUserText) {
      const entry = normalizeClaudeRecord(id, parsed, 1);
      if (entry?.role === "user") {
        firstUserText = entry.text.split("\n")[0].slice(0, 72);
      }
    }
  }

  const fileInfo = await stat(filePath);
  const safeProjectPath = resumePath || currentPath || path.dirname(filePath);
  const projectName = basename(safeProjectPath);
  const title = firstUserText || `Claude ${projectName}`;

  return {
    filePath,
    id,
    name: `${title}${title.includes(id.slice(0, 8)) ? "" : ` · ${id.slice(0, 8)}`}`,
    projectPath: safeProjectPath,
    resumePath: resumePath || safeProjectPath,
    updatedAt: updatedAt || fileInfo.mtime.toISOString(),
  };
}

async function parseClaudeTranscriptFile(session, { limit = DEFAULT_TRANSCRIPT_LIMIT } = {}) {
  const fileInfo = await stat(session.filePath);
  const safeLimit = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TRANSCRIPT_LIMIT);
  const { offset, raw } = await readTranscriptTail(session.filePath, fileInfo.size, safeLimit * 3);
  const transcript = [];
  const startsAtBeginning = offset === 0;
  let lineNumber = startsAtBeginning ? 0 : offset;
  let skippedPartialLine = false;

  for (const line of raw.split("\n")) {
    if (!startsAtBeginning && !skippedPartialLine) {
      skippedPartialLine = true;
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    lineNumber += 1;
    const parsed = safeJsonParse(line);
    if (!parsed) {
      continue;
    }

    const entry = normalizeClaudeRecord(session.id, parsed, lineNumber);
    if (entry) {
      transcript.push(entry);
    }
  }

  const trimmed = transcript.slice(-safeLimit);
  return {
    cursor: {
      emittedIds: new Set(trimmed.map((entry) => entry.id)),
      nextLineNumber: lineNumber + 1,
      offset: fileInfo.size,
      remainder: "",
    },
    transcript: trimmed,
  };
}

function normalizeLogicalTranscriptEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const role = entry.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }

  const id = trimText(entry.id);
  const text = trimText(entry.text);
  if (!id || !text) {
    return null;
  }

  return {
    id,
    role,
    text,
    time: trimText(entry.time) || nowIso(),
    ...(entry.toolActivity && typeof entry.toolActivity === "object" ? { toolActivity: entry.toolActivity } : {}),
  };
}

function mergeTranscriptEntries(baseEntries, overlayEntries) {
  const byId = new Map();
  for (const entry of [...baseEntries, ...overlayEntries]) {
    if (!entry?.id) {
      continue;
    }
    byId.set(entry.id, entry);
  }

  return Array.from(byId.values())
    .sort((left, right) => {
      const timeOrder = String(left.time || "").localeCompare(String(right.time || ""));
      if (timeOrder !== 0) {
        return timeOrder;
      }
      return String(left.id || "").localeCompare(String(right.id || ""));
    })
    .slice(-DEFAULT_TRANSCRIPT_LIMIT);
}

function mergeTranscriptEntriesWithLimit(baseEntries, overlayEntries, limit = DEFAULT_TRANSCRIPT_LIMIT) {
  const safeLimit = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TRANSCRIPT_LIMIT);
  const byId = new Map();
  for (const entry of [...baseEntries, ...overlayEntries]) {
    if (!entry?.id) {
      continue;
    }
    byId.set(entry.id, entry);
  }

  return Array.from(byId.values())
    .sort((left, right) => {
      const timeOrder = String(left.time || "").localeCompare(String(right.time || ""));
      if (timeOrder !== 0) {
        return timeOrder;
      }
      return String(left.id || "").localeCompare(String(right.id || ""));
    })
    .slice(-safeLimit);
}

function findTranscriptAnchorIndex(entries, anchor) {
  if (!anchor) {
    return -1;
  }

  const byId = entries.findIndex((entry) => entry.id === anchor.id);
  if (byId >= 0) {
    return byId;
  }

  const anchorText = trimText(anchor.text);
  return entries.findIndex((entry) => (
    entry.role === anchor.role &&
    trimText(entry.text) === anchorText &&
    String(entry.time || "") === String(anchor.time || "")
  ));
}

async function inspectClaudeSessionThinking(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({
    crlfDelay: Infinity,
    input: stream,
  });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim() || !line.includes("thinking")) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (parsed && claudeRecordHasThinking(parsed)) {
        return {
          hasThinking: true,
          lineNumber,
        };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return {
    hasThinking: false,
    lineNumber: null,
  };
}

function createDefaultReadiness({ binaryPath, sendRequested }) {
  return {
    binaryPath,
    checkedAt: null,
    reason: sendRequested
      ? "Claude runtime readiness has not been checked yet."
      : "Claude send is disabled. Set CLAUDE2WEB_ENABLE_SEND=true in the lab service to run the real send probe.",
    runtimeReady: false,
    sendReady: false,
    sendRequested,
    version: "",
  };
}

function summarizeProcessOutput(stdout, stderr) {
  const combined = [stdout, stderr].map((value) => trimText(value)).filter(Boolean).join("\n");
  for (const line of combined.split("\n")) {
    const parsed = safeJsonParse(line);
    const errors = Array.isArray(parsed?.errors) ? parsed.errors.map((error) => trimText(error)).filter(Boolean) : [];
    if (errors.length > 0) {
      return errors.join("; ").replace(/\s+/g, " ").slice(0, 400);
    }

    const result = trimText(parsed?.result);
    if (result) {
      return result.replace(/\s+/g, " ").slice(0, 240);
    }
  }

  return combined.replace(/\s+/g, " ").slice(0, 240);
}

function extractModelUsageModels(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") {
    return [];
  }

  if (Array.isArray(modelUsage)) {
    return modelUsage
      .map((entry) => normalizeModelName(entry?.model || entry?.name || entry?.id))
      .filter(Boolean);
  }

  return Object.keys(modelUsage)
    .map((model) => normalizeModelName(model))
    .filter(Boolean);
}

function extractExecutionModelEvidence(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const modelUsageModels = extractModelUsageModels(record.modelUsage);
  const model = normalizeModelName(
    modelUsageModels[0] ||
      record.model ||
      record.message?.model ||
      record.result?.model ||
      record.result?.message?.model ||
      "",
  );

  if (!model && modelUsageModels.length === 0) {
    return null;
  }

  return {
    actualModel: model || modelUsageModels[0] || "",
    modelUsage: record.modelUsage && typeof record.modelUsage === "object" ? record.modelUsage : null,
    modelUsageModels,
  };
}

function extractExecutionModelEvidenceFromOutput(stdout) {
  let evidence = null;
  for (const line of String(stdout || "").split("\n")) {
    const parsed = safeJsonParse(line);
    const nextEvidence = extractExecutionModelEvidence(parsed);
    if (nextEvidence?.actualModel || nextEvidence?.modelUsageModels?.length > 0) {
      evidence = nextEvidence;
    }
  }
  return evidence;
}

function formatExecutionModelDetail(selection, evidence) {
  const selected = selection?.model ? `${selection.provider}:${selection.model}` : "unknown";
  const actual = evidence?.actualModel || "";
  if (!actual) {
    return `选择模型：${selected}；实际模型：等待 Claude CLI 返回 modelUsage。`;
  }
  return `选择模型：${selected}；实际模型：${actual}。`;
}

export function buildClaudePromptWithImages(prompt, imagePaths, { imageAnalyses = [], imageMode = "native" } = {}) {
  const cleanPrompt = trimText(prompt);
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return cleanPrompt;
  }

  if (imageMode !== "ocr") {
    const imageSections = imagePaths.map((filePath, index) => `图片 ${index + 1}: ${filePath}`);
    return [
      cleanPrompt,
      "",
      "已附加图片文件。请直接读取并理解这些本地图片；必要时使用 Read 工具查看原图，不要把它当作 OCR 文本处理。",
      "",
      "图片文件：",
      ...imageSections,
    ].join("\n");
  }

  const analysisByPath = new Map(
    (Array.isArray(imageAnalyses) ? imageAnalyses : [])
      .filter((item) => trimText(item?.path))
      .map((item) => [item.path, item]),
  );
  const imageSections = imagePaths.map((filePath, index) => {
    const analysis = analysisByPath.get(filePath) || {};
    const ocrText = trimText(analysis.text);
    const error = trimText(analysis.error);
    const header = `图片 ${index + 1}: ${filePath}`;
    if (ocrText) {
      return [
        header,
        `服务端 OCR 识别文本（${String(analysis.lineCount || ocrText.split(/\n+/).length)} 行）:`,
        "```text",
        ocrText,
        "```",
      ].join("\n");
    }
    if (error) {
      return [header, `服务端 OCR 未成功: ${error}`].join("\n");
    }
    return [header, "服务端 OCR 未识别到可读文本。"].join("\n");
  });

  return [
    cleanPrompt,
    "",
    "已附加图片。注意：当前模型使用 DeepSeek Anthropic 兼容接口，无法稳定接收 Claude Code 原生 image content，因此服务端已先对图片执行 OCR，并把可读文本作为上下文提供。",
    "请基于用户问题、下方 OCR 文本和文件路径回答；不要再说无法直接查看图片，除非 OCR 文本不足以判断。",
    "",
    "图片 OCR 上下文：",
    ...imageSections,
  ].join("\n");
}

function runClaudeCommand({ args, binaryPath, cwd, env = null, input = "", timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      cwd,
      env: env || {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref?.();

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stderr,
        stdout,
        ...result,
      });
    };

    child.on("error", (error) => {
      settle({
        code: null,
        error,
        signal: null,
        timedOut: false,
      });
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code, signal) => {
      settle({
        code,
        error: null,
        signal,
        timedOut: signal === "SIGTERM",
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export class ClaudeReadonlyBridge {
  #activeSendRuns = new Map();
  #auditFilePath;
  #auditTrail = [];
  #claudeBinaryPath;
  #events = new EventEmitter();
  #executionStateBySession = new Map();
  #lastSessionRefreshAt = 0;
  #modelCatalog = [];
  #modelCatalogRefreshedAt = null;
  #modelSelection = null;
  #modelSelectionsBySession = new Map();
  #pendingProviderBridgesBySession = new Map();
  #providerRuns = { sessions: {} };
  #providerRunsFilePath;
  #pinnedSessionId = null;
  #pollTimer = null;
  #readinessRefreshInFlight = null;
  #readinessRetryTimer = null;
  #sendReadiness;
  #sendRequested;
  #sendingSessionIds = new Set();
  #sessionCursors = new Map();
  #sessionRunAliases = new Map();
  #ephemeralSessionsById = new Map();
  #sessionRootPath;
  #sessions = [];
  #sessionsById = new Map();
  #stateFilePath;
  #transcriptCache = new Map();
  #logicalTranscriptDir;
  #logicalTranscriptPersistedIds = new Map();

  constructor({ auditFilePath, claudeBinaryPath, sendRequested = false, sessionRootPath, stateFilePath }) {
    this.#auditFilePath = auditFilePath;
    this.#claudeBinaryPath = trimText(claudeBinaryPath) || DEFAULT_CLAUDE_BINARY;
    this.#sendRequested = Boolean(sendRequested);
    this.#sendReadiness = createDefaultReadiness({
      binaryPath: this.#claudeBinaryPath,
      sendRequested: this.#sendRequested,
    });
    this.#sessionRootPath = normalizePath(sessionRootPath) || DEFAULT_CLAUDE_PROJECTS_ROOT;
    this.#stateFilePath = stateFilePath;
    this.#logicalTranscriptDir = path.join(path.dirname(this.#stateFilePath), "claude-logical-transcripts");
    this.#providerRunsFilePath = path.join(path.dirname(this.#stateFilePath), "claude-provider-runs.json");
  }

  async init() {
    await this.#refreshModelCatalog();
    await this.#refreshSessions(true);
    await this.#readPersistedProviderRuns();
    const persistedState = await this.#readPersistedState();
    this.#modelSelection = this.#resolveInitialModelSelection(persistedState?.modelSelection);
    this.#modelSelectionsBySession = new Map(
      Object.entries(persistedState?.sessionModelSelections || {})
        .map(([sessionId, selection]) => [sessionId, resolveModelSelection(this.#modelCatalog, selection || {})])
        .filter(([sessionId, selection]) => sessionId && selection),
    );
    await this.#refreshReadiness();
    const persistedSessionId = persistedState?.pinnedSessionId || null;
    const hasPersistedPin = this.#sessionsById.has(persistedSessionId);
    this.#pinnedSessionId = hasPersistedPin ? persistedSessionId : this.#sessions[0]?.id || null;

    if (this.#pinnedSessionId) {
      await this.#persistPinnedSessionId();
      this.#recordAudit({
        action: hasPersistedPin ? "session_restore" : "claude_readonly_initial",
        detail: hasPersistedPin
          ? "Pinned Claude readonly session restored from lab state."
          : "Most recent local Claude session selected for readonly inspection.",
        nextSessionId: this.#pinnedSessionId,
        prevSessionId: null,
      });
    }

    this.#startPolling();
  }

  subscribe(handler) {
    this.#events.on("event", handler);
    return () => {
      this.#events.off("event", handler);
    };
  }

  getProviderInfo(sessionId = this.#pinnedSessionId) {
    const currentModel = this.#getCurrentModelSelection(sessionId);
    return {
      capabilities: {
        discoverSessions: true,
        runtimeReady: this.#sendReadiness.runtimeReady,
        send: this.#sendReadiness.sendReady,
        stop: this.#sendReadiness.sendReady,
        transcript: true,
      },
      displayName: "Claude",
      id: "claude",
      model: {
        available: this.#modelCatalog.map((option) => ({
          id: option.id,
          label: option.label,
          model: option.model,
          provider: option.provider,
          source: option.source,
        })),
        current: {
          id: currentModel.id,
          label: currentModel.label,
          model: currentModel.model,
          provider: currentModel.provider,
          source: currentModel.source,
        },
        discovery: {
          customInput: true,
          refreshedAt: this.#modelCatalogRefreshedAt,
          sources: [
            "Claude user settings",
            "Claude global cached config",
            "Claude2Web runtime env",
            "recent successful model usage",
          ],
        },
      },
      mode: this.#sendReadiness.sendReady ? "interactive" : "readonly",
      readiness: { ...this.#sendReadiness },
      readonly: !this.#sendReadiness.sendReady,
      summary: this.#sendReadiness.sendReady
        ? `Claude provider can send with ${currentModel.label}.`
        : `Claude send unavailable: ${this.#sendReadiness.reason}`,
    };
  }

  async discoverSessions() {
    await this.#refreshSessions();
    return this.#sessions
      .filter((session) => !isDeepSeekSafeForkSession(session))
      .map((session) => this.#toPublicSession(session));
  }

  getFailureModes() {
    return {
      attach: false,
      connection: false,
      send: false,
    };
  }

  getAuditTrail(limit = 30) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 30;
    return this.#auditTrail.slice(-safeLimit).reverse().map((entry) => ({ ...entry }));
  }

  getExecutionPolicy(sessionId = this.#pinnedSessionId) {
    return {
      cliArgs: [],
      displayName: this.#sendReadiness.sendReady ? "Claude Lab Send" : "Claude Readiness Gated",
      profile: this.#sendReadiness.sendReady ? "claude-lab-send" : "readonly",
      source: "provider",
      summary: this.#sendReadiness.sendReady
        ? `Claude send is enabled with ${this.#getCurrentModelSelection(sessionId).label}. Use /model or the page model switcher to change models.`
        : this.#sendReadiness.reason,
      trustBoundary: this.#sendReadiness.sendReady ? "local-lab-claude-send" : "local-readonly",
    };
  }

  async setModelSelection(request = {}) {
    await this.#refreshModelCatalog();
    const nextSelection = resolveModelSelection(this.#modelCatalog, request);
    if (!nextSelection) {
      throw new BridgeError(400, "Model name is required.", "INVALID_MODEL");
    }

    const sessionId = trimText(request.sessionId) || this.#pinnedSessionId;
    const previousSelection = this.#getCurrentModelSelection(sessionId);
    if (sessionId) {
      this.#modelSelectionsBySession.set(sessionId, nextSelection);
    } else {
      this.#modelSelection = nextSelection;
    }
    if (previousSelection.provider && nextSelection.provider && previousSelection.provider !== nextSelection.provider) {
      this.#pendingProviderBridgesBySession.set(sessionId, {
        createdAt: nowIso(),
        fromModel: previousSelection.model,
        fromProvider: previousSelection.provider,
        sessionId,
        toModel: nextSelection.model,
        toProvider: nextSelection.provider,
      });
    }
    await this.#persistPinnedSessionId();
    this.#recordAudit({
      action: "model_switch",
      detail: `Model switched from ${previousSelection.provider}:${previousSelection.model} to ${nextSelection.provider}:${nextSelection.model}.`,
      nextSessionId: sessionId,
      prevSessionId: sessionId,
    });

	    if (this.#sendRequested) {
	      await this.#refreshReadiness();
	    }

	    const executionState = this.#executionStateBySession.get(sessionId);
	    if (executionState && executionState.phase !== "starting" && executionState.phase !== "running" && executionState.phase !== "stopping") {
	      this.#setExecutionState(sessionId, {
	        acceptedAt: null,
	        actualModel: null,
	        exitCode: null,
	        lastActivityAt: nowIso(),
	        lastVisibleMessageAt: null,
	        modelUsage: null,
	        modelUsageModels: [],
	        phase: "idle",
	        pid: null,
	        processAlive: false,
	        selectedModel: nextSelection,
	        startedAt: null,
	        statusDetail: this.#sendReadiness.sendReady
	          ? `模型已切换为 ${nextSelection.label}，下一次发送将使用 ${nextSelection.provider}:${nextSelection.model}。`
	          : `模型已切换为 ${nextSelection.label}，但发送未就绪：${this.#sendReadiness.reason}`,
	      }, { emit: false });
	    }

	    this.#emit("state", this.getBinding(sessionId));
	    return {
      model: this.getProviderInfo(sessionId).model,
      provider: this.getProviderInfo(sessionId),
    };
  }

  getExecutionRuntimeConfig() {
    return {
      maxRuntimeMs: EXECUTION_MAX_RUNTIME_MS,
      stallWatchdogIntervalMs: EXECUTION_STALL_WATCHDOG_INTERVAL_MS,
      visibleOutputStallMs: EXECUTION_VISIBLE_OUTPUT_STALL_MS,
    };
  }

  #createDefaultExecutionState(sessionId) {
    return {
      acceptedAt: null,
      exitCode: null,
      lastActivityAt: null,
      lastToolActivity: null,
      lastVisibleMessageAt: null,
      actualModel: null,
      modelUsage: null,
      modelUsageModels: [],
      phase: "idle",
      pid: null,
      processAlive: false,
      selectedModel: this.#getCurrentModelSelection(sessionId),
      sessionId: sessionId || null,
      startedAt: null,
      statusDetail: this.#sendReadiness.sendReady
        ? `Claude lab send is ready. 当前模型：${this.#getCurrentModelSelection(sessionId).label}。`
        : `Claude send unavailable: ${this.#sendReadiness.reason}`,
      updatedAt: nowIso(),
    };
  }

  #getExecutionState(sessionId) {
    if (!sessionId) {
      return null;
    }

    return {
      ...this.#createDefaultExecutionState(sessionId),
      ...this.#executionStateBySession.get(sessionId),
    };
  }

  #setExecutionState(sessionId, patch, { emit = true } = {}) {
    if (!sessionId) {
      return this.#createDefaultExecutionState(sessionId);
    }

    const nextState = {
      ...this.#createDefaultExecutionState(sessionId),
      ...this.#executionStateBySession.get(sessionId),
      ...patch,
      sessionId,
      statusDetail: trimText(patch?.statusDetail ?? this.#executionStateBySession.get(sessionId)?.statusDetail ?? ""),
      updatedAt: nowIso(),
    };

    this.#executionStateBySession.set(sessionId, nextState);

    if (emit) {
      this.#emit("state", this.getBinding());
    }

    return { ...nextState };
  }

  #clearRunTimers(runContext) {
    if (!runContext) {
      return;
    }

    for (const timerKey of ["stallWatchdogTimer", "stopEscalationTimer"]) {
      if (runContext[timerKey]) {
        clearTimeout(runContext[timerKey]);
        runContext[timerKey] = null;
      }
    }
  }

  #finishRun(sessionId, runContext) {
    this.#clearRunTimers(runContext);
    this.#activeSendRuns.delete(sessionId);
    this.#sendingSessionIds.delete(sessionId);
    if (runContext?.logicalSessionId && runContext.logicalSessionId !== sessionId) {
      this.#sendingSessionIds.delete(runContext.logicalSessionId);
      this.#sessionRunAliases.delete(runContext.logicalSessionId);
      this.#ephemeralSessionsById.delete(sessionId);
    }
  }

  async #finishRunAfterFinalPoll(session, runContext) {
    try {
      await this.#pollSession(session);
    } catch (error) {
      process.stderr.write(`Failed to poll final Claude transcript output: ${String(error)}\n`);
    } finally {
      this.#finishRun(session.id, runContext);
    }
  }

  #getLogicalSession(session, runContext) {
    if (runContext?.logicalSessionId) {
      return this.#getSession(runContext.logicalSessionId) || session;
    }
    return session;
  }

  #setRunExecutionState(session, runContext, patch, options) {
    const logicalSession = this.#getLogicalSession(session, runContext);
    return this.#setExecutionState(logicalSession.id, patch, options);
  }

  #requestRunStop(session, runContext, { detail, phase = "stopping", status = "stopping" } = {}) {
    if (!session?.id || !runContext?.child || runContext.child.exitCode != null) {
      return false;
    }

    const message = trimText(detail) || "停止请求已发出，等待 Claude 进程退出。";
    const logicalSession = this.#getLogicalSession(session, runContext);
    runContext.stopRequested = true;
    this.#setRunExecutionState(session, runContext, {
      lastActivityAt: nowIso(),
      phase,
      pid: runContext.child.pid || null,
      processAlive: true,
      statusDetail: message,
    }, { emit: false });
    this.#emit("stop", {
      message,
      sessionId: logicalSession.id,
      status,
      time: nowIso(),
    });
    this.#emit("state", this.getBinding());

    const signaled = runContext.child.kill("SIGINT");
    if (!signaled) {
      runContext.stopRequested = false;
      this.#emit("stop", {
        message: "停止失败：无法向 Claude 进程发送中断信号。",
        sessionId: logicalSession.id,
        status: "stop-failed",
        time: nowIso(),
      });
      this.#setRunExecutionState(session, runContext, {
        lastActivityAt: nowIso(),
        phase: "failed",
        pid: runContext.child.pid || null,
        processAlive: false,
        statusDetail: "停止失败：无法向 Claude 进程发送中断信号。",
      }, { emit: false });
      this.#emit("state", this.getBinding());
      return false;
    }

    if (runContext.stopEscalationTimer) {
      clearTimeout(runContext.stopEscalationTimer);
    }
    runContext.stopEscalationTimer = setTimeout(() => {
      if (runContext.child.exitCode == null) {
        runContext.child.kill("SIGTERM");
      }
    }, STOP_ESCALATION_TIMEOUT_MS);
    runContext.stopEscalationTimer.unref?.();
    return true;
  }

  #startRunWatchdog(session, runContext) {
    const check = () => {
      if (!this.#activeSendRuns.has(session.id) || runContext.child.exitCode != null) {
        this.#clearRunTimers(runContext);
        return;
      }

      const now = Date.now();
      const startedAtMs = Date.parse(runContext.startedAt);
      const lastVisibleAtMs = Date.parse(runContext.lastVisibleMessageAt || runContext.acceptedAt || runContext.startedAt);
      const lastToolAtMs = Date.parse(runContext.lastToolActivity?.time || "");
      const runtimeMs = Number.isFinite(startedAtMs) ? now - startedAtMs : 0;
      const quietVisibleMs = Number.isFinite(lastVisibleAtMs) ? now - lastVisibleAtMs : 0;
      const quietToolMs = Number.isFinite(lastToolAtMs) ? now - lastToolAtMs : quietVisibleMs;

      if (runtimeMs >= EXECUTION_MAX_RUNTIME_MS) {
        this.#requestRunStop(session, runContext, {
          detail: `Claude 执行已超过 ${Math.round(EXECUTION_MAX_RUNTIME_MS / 60000)} 分钟上限，已自动停止并释放发送锁。`,
          status: "stopping",
        });
        return;
      }

      if (quietVisibleMs >= EXECUTION_VISIBLE_OUTPUT_STALL_MS) {
        const toolSummary = trimText(runContext.lastToolActivity?.summary);
        this.#requestRunStop(session, runContext, {
          detail: toolSummary
            ? `Claude 执行已超过 ${Math.round(EXECUTION_VISIBLE_OUTPUT_STALL_MS / 60000)} 分钟没有新的可见输出；最近工具活动：${toolSummary}，已 ${Math.round(quietToolMs / 1000)} 秒无更新。已自动停止并释放发送锁。`
            : `Claude 执行已超过 ${Math.round(EXECUTION_VISIBLE_OUTPUT_STALL_MS / 60000)} 分钟没有新的可见输出，已自动停止并释放发送锁。`,
          status: "stopping",
        });
        return;
      }

      runContext.stallWatchdogTimer = setTimeout(check, EXECUTION_STALL_WATCHDOG_INTERVAL_MS);
      runContext.stallWatchdogTimer.unref?.();
    };

    runContext.stallWatchdogTimer = setTimeout(check, EXECUTION_STALL_WATCHDOG_INTERVAL_MS);
    runContext.stallWatchdogTimer.unref?.();
  }

  getBinding(sessionId = this.#pinnedSessionId) {
    const effectiveSessionId = trimText(sessionId) || this.#pinnedSessionId;
    const session = this.#getSession(effectiveSessionId);
    const isSending = this.#sendingSessionIds.has(effectiveSessionId);
    let executionState = this.#getExecutionState(effectiveSessionId);
    if (
      !isSending &&
      executionState &&
      (executionState.phase === "starting" || executionState.phase === "running" || executionState.phase === "stopping")
    ) {
      executionState = this.#setExecutionState(effectiveSessionId, {
        lastActivityAt: nowIso(),
        phase: "idle",
        pid: null,
        processAlive: false,
        statusDetail: "没有活动中的 Claude2Web 执行进程，已恢复为空闲状态。",
      }, { emit: false });
    }
    const send = !this.#sendReadiness.sendReady
      ? "disabled"
      : executionState?.phase === "failed"
        ? "error"
        : isSending
          ? executionState?.phase === "stopping"
            ? "stopping"
            : "sending"
          : "idle";
    return {
      attach: session ? "attached" : "error",
      connection: "connected",
      execution: this.getExecutionPolicy(effectiveSessionId),
      executionState,
      pinnedSessionId: effectiveSessionId,
      provider: this.getProviderInfo(effectiveSessionId),
      send,
      session: session ? this.#toPublicSession(session) : null,
      stream: "streaming",
      updatedAt: nowIso(),
    };
  }

  async getTranscript(sessionId = this.#pinnedSessionId) {
    if (!sessionId) {
      return [];
    }

    await this.#refreshSessions();
    const session = this.#getSession(sessionId);
    if (!session) {
      return [];
    }
    if (!session.filePath) {
      return [];
    }

    let parsedTranscript;
    try {
      parsedTranscript = await parseClaudeTranscriptFile(session);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const { cursor } = parsedTranscript;
    const transcript = parsedTranscript.transcript.filter((entry) => !isInternalProviderScaffoldText(entry.text));
    this.#sessionCursors.set(sessionId, cursor);
    await this.#syncDeepSeekRunTranscript(sessionId);
    const logicalEntries = await this.#readLogicalTranscript(sessionId);
    const mergedTranscript = mergeTranscriptEntries(transcript, logicalEntries);
    this.#transcriptCache.set(sessionId, mergedTranscript);
    return mergedTranscript.map((entry) => ({ ...entry }));
  }

  async getTranscriptSnapshot({ afterId = "", forceFull = false, sessionId = this.#pinnedSessionId } = {}) {
    if (!sessionId) {
      return {
        entries: [],
        latestEntryId: null,
        reset: false,
      };
    }

    await this.#refreshSessions();
    const session = this.#getSession(sessionId);
    if (!session) {
      return {
        entries: [],
        latestEntryId: null,
        reset: false,
      };
    }

    const syncedCount = await this.#syncDeepSeekRunTranscript(sessionId);
    if (syncedCount > 0) {
      this.#transcriptCache.delete(sessionId);
    }

    let transcript = this.#transcriptCache.get(sessionId);
    if (!transcript) {
      transcript = await this.getTranscript(sessionId);
    }

    const latestEntryId = transcript.at(-1)?.id || null;
    if (forceFull || !afterId) {
      return {
        entries: transcript.map((entry) => ({ ...entry })),
        latestEntryId,
        reset: true,
      };
    }

    const startIndex = transcript.findIndex((entry) => entry.id === afterId);
    if (startIndex >= 0) {
      return {
        entries: transcript.slice(startIndex + 1).map((entry) => ({ ...entry })),
        latestEntryId,
        reset: false,
      };
    }

    return {
      entries: transcript.map((entry) => ({ ...entry })),
      latestEntryId,
      reset: true,
    };
  }

  async getTranscriptHistoryPage({ beforeId = "", limit = 80, sessionId = this.#pinnedSessionId } = {}) {
    if (!sessionId || !beforeId) {
      return {
        entries: [],
        hasMore: false,
        oldestEntryId: null,
      };
    }

    await this.#refreshSessions();
    const session = this.#getSession(sessionId);
    if (!session?.filePath) {
      return {
        entries: [],
        hasMore: false,
        oldestEntryId: null,
      };
    }

    const safeLimit = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 80));
    const visibleTranscript = this.#transcriptCache.get(sessionId) || await this.getTranscript(sessionId);
    const visibleAnchor = visibleTranscript.find((entry) => entry.id === beforeId) || { id: beforeId };

    let parsedTranscript;
    try {
      parsedTranscript = await parseClaudeTranscriptFile(session, { limit: HISTORY_TRANSCRIPT_LIMIT });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          entries: [],
          hasMore: false,
          oldestEntryId: null,
        };
      }
      throw error;
    }

    const logicalEntries = await this.#readLogicalTranscript(sessionId, { limit: HISTORY_TRANSCRIPT_LIMIT });
    const transcript = mergeTranscriptEntriesWithLimit(
      parsedTranscript.transcript.filter((entry) => !isInternalProviderScaffoldText(entry.text)),
      logicalEntries,
      HISTORY_TRANSCRIPT_LIMIT,
    );
    const anchorIndex = findTranscriptAnchorIndex(transcript, visibleAnchor);
    if (anchorIndex <= 0) {
      return {
        entries: [],
        hasMore: false,
        oldestEntryId: transcript[0]?.id || null,
      };
    }

    const startIndex = Math.max(0, anchorIndex - safeLimit);
    const entries = transcript.slice(startIndex, anchorIndex);
    return {
      entries: entries.map((entry) => ({ ...entry })),
      hasMore: startIndex > 0,
      oldestEntryId: transcript[0]?.id || null,
    };
  }

  async attachSession(sessionId, explicit, options = {}) {
    if (explicit !== true) {
      throw new BridgeError(
        400,
        "Attach requires explicit=true to prevent silent session switching.",
        "ATTACH_NOT_EXPLICIT",
      );
    }

    await this.#refreshSessions(true);
    const target = this.#getSession(sessionId);
    if (!target) {
      throw new BridgeError(404, "Session not found.", "SESSION_NOT_FOUND");
    }

    const previousPinnedSessionId = this.#pinnedSessionId;
    if (options.persist !== false) {
      this.#pinnedSessionId = target.id;
      await this.#persistPinnedSessionId();
    }
    this.#recordAudit({
      action: "session_switch",
      detail: "User explicitly switched the pinned local Claude readonly session.",
      nextSessionId: target.id,
      prevSessionId: previousPinnedSessionId,
    });
    this.#emit("pinned", {
      pinnedSessionId: target.id,
      session: this.#toPublicSession(target),
      updatedAt: nowIso(),
    });
    this.#emit("state", this.getBinding(target.id));

    return this.getBinding(target.id);
  }

  async sendInput(message, options = {}) {
    const requestedSessionId = trimText(options?.sessionId) || this.#pinnedSessionId;
    const trimmed = trimText(message);
    const imagePaths = Array.isArray(options?.imagePaths)
      ? options.imagePaths.map((filePath) => normalizePath(filePath)).filter(Boolean)
      : [];
    const imageAnalyses = Array.isArray(options?.imageAnalyses) ? options.imageAnalyses : [];
    const modelCommand = parseModelCommand(trimmed);
    if (modelCommand) {
      if (!modelCommand.requested) {
        return {
          message: formatModelList(this.#modelCatalog, this.#getCurrentModelSelection(requestedSessionId)),
          model: this.getProviderInfo(requestedSessionId).model,
          modelCommand: true,
          sessionId: requestedSessionId,
        };
      }
      const result = await this.setModelSelection({ model: modelCommand.requested, sessionId: requestedSessionId });
      return {
        message: `模型已切换为 ${result.model.current.model} (${result.model.current.provider})。`,
        model: result.model,
        modelCommand: true,
        sessionId: requestedSessionId,
      };
    }

    if (!trimmed || trimmed.length < 2) {
      throw new BridgeError(400, "Message must be at least 2 characters.", "INVALID_MESSAGE");
    }

    await this.#refreshSessions(true);
    const session = this.#getSession(requestedSessionId);
    if (!session) {
      throw new BridgeError(409, "Pinned session is not attached.", "SESSION_ATTACH_ERROR");
    }

    if (!this.#sendReadiness.sendReady) {
      throw new BridgeError(
        503,
        `Claude send is unavailable: ${this.#sendReadiness.reason}`,
        this.#sendRequested ? "PROVIDER_RUNTIME_NOT_READY" : "PROVIDER_READONLY",
      );
    }

    if (this.#sendingSessionIds.has(session.id)) {
      throw new BridgeError(409, "Pinned session is still processing the previous instruction.", "SEND_IN_PROGRESS");
    }

    const pendingBridge = this.#pendingProviderBridgesBySession.get(session.id)?.sessionId === session.id
      ? { ...this.#pendingProviderBridgesBySession.get(session.id) }
      : null;
    const target = await this.#prepareSessionForCurrentModel(session, trimmed, { providerBridge: pendingBridge });

    const logicalSession = target.logicalSession || target.session;
    this.#sendingSessionIds.add(logicalSession.id);
    if (target.session.id !== logicalSession.id) {
      this.#sessionRunAliases.set(logicalSession.id, target.session.id);
    }
    this.#setExecutionState(logicalSession.id, {
      acceptedAt: null,
      exitCode: null,
      lastActivityAt: nowIso(),
      lastVisibleMessageAt: null,
      actualModel: null,
      modelUsage: null,
      modelUsageModels: [],
      phase: "starting",
      pid: null,
      processAlive: false,
      selectedModel: this.#getCurrentModelSelection(logicalSession.id),
      startedAt: nowIso(),
      statusDetail: target.forked
        ? `原 session 含 Claude thinking 历史，已创建 DeepSeek 安全分支 ${target.session.id.slice(0, 8)}，正在带入最近上下文执行。`
        : target.providerBridgeApplied
          ? `检测到 provider 从 ${pendingBridge.fromProvider} 切到 ${pendingBridge.toProvider}，已带入最近上下文恢复包，正在启动 Claude resume。`
          : imagePaths.length > 0
          ? `指令已发送，已附加 ${String(imagePaths.length)} 张图片，正在启动 Claude resume。`
          : "指令已发送，正在启动 Claude resume。",
    }, { emit: false });
    this.#emit("state", this.getBinding(logicalSession.id));

    try {
      const result = await this.#startSendProcess(target.session, target.prompt, {
        imageAnalyses,
        imagePaths,
        logicalSession,
        resume: !target.forked,
      });
      if (target.session.id !== logicalSession.id) {
        await this.#pollSession(target.session);
      }
      if (target.providerBridgeApplied) {
        const logicalProviderBridgeEntryId = `${logicalSession.id}:provider-bridge-user:${result.acceptedAt || nowIso()}`;
        await this.#appendLogicalTranscriptEntry(logicalSession.id, {
          id: logicalProviderBridgeEntryId,
          role: "user",
          text: trimmed,
          time: result.acceptedAt || nowIso(),
        });
      }
      if (target.deepSeekRun?.initializing) {
        await this.#markDeepSeekRunReady(logicalSession.id, target.session.id);
      }
      if (target.providerBridgeApplied && this.#pendingProviderBridgesBySession.get(logicalSession.id)?.sessionId === logicalSession.id) {
        this.#pendingProviderBridgesBySession.delete(logicalSession.id);
      }
      if (target.session.id !== logicalSession.id) {
        const logicalUserEntryId = `${logicalSession.id}:logical-user:${target.session.id}`;
        await this.#appendLogicalTranscriptEntry(logicalSession.id, {
          id: logicalUserEntryId,
          role: "user",
          text: trimmed,
          time: result.acceptedAt || nowIso(),
        });
        await this.#advanceDeepSeekRunSyncedEntry(logicalSession.id, target.session.id, logicalUserEntryId);
      }
      return {
        ...result,
        acceptedAt: nowIso(),
        forked: target.forked,
        imageCount: imagePaths.length,
        providerBridgeApplied: Boolean(target.providerBridgeApplied),
        reusedDeepSeekRun: Boolean(target.reusedDeepSeekRun),
      };
    } catch (error) {
      if (target.deepSeekRun?.initializing) {
        await this.#markDeepSeekRunFailed(logicalSession.id, target.session.id, "failed");
      }
      this.#sendingSessionIds.delete(logicalSession.id);
      this.#sessionRunAliases.delete(logicalSession.id);
      this.#emit("state", this.getBinding(logicalSession.id));
      throw error;
    }
  }

  async stopInput(options = {}) {
    const requestedSessionId = trimText(options?.sessionId) || this.#pinnedSessionId;
    const session = this.#getSession(requestedSessionId);
    if (!session) {
      throw new BridgeError(409, "Pinned session is not attached.", "SESSION_ATTACH_ERROR");
    }

    if (!this.#sendReadiness.sendReady) {
      throw new BridgeError(503, `Claude stop is unavailable: ${this.#sendReadiness.reason}`, "PROVIDER_RUNTIME_NOT_READY");
    }

    if (!this.#sendingSessionIds.has(session.id)) {
      return {
        message: "当前没有正在执行的 Claude 对话。",
        sessionId: session.id,
        status: "idle",
      };
    }

    const runSessionId = this.#sessionRunAliases.get(session.id) || session.id;
    const runSession = this.#getSession(runSessionId) || this.#ephemeralSessionsById.get(runSessionId) || session;
    const runContext = this.#activeSendRuns.get(runSession.id);
    if (!runContext?.child) {
      throw new BridgeError(409, "Claude execution process is missing.", "STOP_FAILED");
    }

    const signaled = this.#requestRunStop(runSession, runContext, {
      detail: "停止请求已发出，等待 Claude 进程退出。",
    });
    if (!signaled) {
      throw new BridgeError(409, "停止失败：无法向 Claude 进程发送中断信号。", "STOP_FAILED");
    }

    return {
      message: "停止请求已发出，等待 Claude 进程退出。",
      sessionId: session.id,
      signal: "SIGINT",
      status: "stopping",
    };
  }

  async #prepareSessionForCurrentModel(session, prompt, { providerBridge = null } = {}) {
    const currentModel = this.#getCurrentModelSelection(session.id);
    const withProviderBridge = async () => {
      if (!providerBridge || providerBridge.toProvider !== currentModel.provider) {
        return {
          applied: false,
          prompt,
        };
      }
      const transcript = await this.getTranscript(session.id);
      const bridgedPrompt = buildProviderSwitchBridgePrompt({
        bridge: providerBridge,
        prompt,
        selection: currentModel,
        transcript,
      });
      return {
        applied: bridgedPrompt !== prompt,
        prompt: bridgedPrompt,
      };
    };

    if (currentModel.provider !== "deepseek") {
      const bridged = await withProviderBridge();
      return {
        forked: false,
        prompt: bridged.prompt,
        providerBridgeApplied: bridged.applied,
        session,
      };
    }

    const thinkingState = await inspectClaudeSessionThinking(session.filePath);
    if (!thinkingState.hasThinking) {
      const bridged = await withProviderBridge();
      return {
        forked: false,
        prompt: bridged.prompt,
        providerBridgeApplied: bridged.applied,
        session,
      };
    }

    const transcript = await this.getTranscript(session.id);
    const reusableDeepSeekRun = await this.#getReusableDeepSeekRun(session.id, transcript);
    if (reusableDeepSeekRun) {
      const reusedSession = {
        filePath: reusableDeepSeekRun.filePath,
        id: reusableDeepSeekRun.sessionId,
        name: `DeepSeek 安全分支 · ${session.name}`,
        projectPath: session.projectPath,
        resumePath: session.resumePath,
        updatedAt: nowIso(),
      };
      this.#ephemeralSessionsById.set(reusedSession.id, reusedSession);
      this.#sessionsById.set(reusedSession.id, reusedSession);
      this.#recordAudit({
        action: "deepseek_safe_reuse",
        detail: `DeepSeek 继续沿用安全分支 ${reusedSession.id.slice(0, 8)}，未重复注入上下文恢复包。`,
        nextSessionId: reusedSession.id,
        prevSessionId: session.id,
      });
      return {
        forked: false,
        logicalSession: session,
        prompt,
        providerBridgeApplied: false,
        reusedDeepSeekRun: true,
        session: reusedSession,
      };
    }

    const nextSessionId = randomUUID();
    const nextSession = {
      filePath: path.join(path.dirname(session.filePath), `${nextSessionId}.jsonl`),
      id: nextSessionId,
      name: `DeepSeek 安全分支 · ${session.name}`,
      projectPath: session.projectPath,
      resumePath: session.resumePath,
      updatedAt: nowIso(),
    };
    this.#ephemeralSessionsById.set(nextSession.id, nextSession);
    await this.#setDeepSeekRunInitializing(session.id, {
      filePath: nextSession.filePath,
      lastSyncedLogicalEntryId: transcript.at(-1)?.id || null,
      sessionId: nextSession.id,
      sourcePhysicalSessionId: session.id,
    });
    const forkPrompt = buildDeepSeekSafeForkPrompt({
      latestPrompt: prompt,
      sourceSessionId: session.id,
      transcript,
    });
    const detail = `原 session 含 Claude thinking 历史，已自动创建 DeepSeek 安全分支 ${nextSession.id.slice(0, 8)}，并带入最近 ${String(Math.min(transcript.length, DEEPSEEK_FORK_CONTEXT_LIMIT))} 条可见上下文继续执行。`;

    this.#sessionsById.set(nextSession.id, nextSession);
    this.#recordAudit({
      action: "deepseek_safe_fork",
      detail,
      nextSessionId: nextSession.id,
      prevSessionId: session.id,
    });
    this.#setExecutionState(nextSession.id, {
      acceptedAt: null,
      exitCode: null,
      lastActivityAt: nowIso(),
      lastVisibleMessageAt: null,
      actualModel: null,
      modelUsage: null,
      modelUsageModels: [],
      phase: "starting",
      pid: null,
      processAlive: false,
      selectedModel: currentModel,
      startedAt: nowIso(),
      statusDetail: detail,
    }, { emit: false });
    this.#emit("state", this.getBinding());

    return {
      forked: true,
      deepSeekRun: { initializing: true },
      logicalSession: session,
      prompt: forkPrompt,
      providerBridgeApplied: false,
      session: nextSession,
    };
  }

  setFailureMode() {
    throw new BridgeError(501, "Claude readonly provider does not support QA failure injection.", "PROVIDER_READONLY");
  }

  resetFailureModes() {
    return this.getFailureModes();
  }

  async #refreshModelCatalog() {
    this.#modelCatalog = await discoverDynamicModelCatalog({ claudeBinaryPath: this.#claudeBinaryPath });
    this.#modelCatalogRefreshedAt = nowIso();
  }

  #resolveInitialModelSelection(persistedSelection) {
    const requestedDefault = process.env.CLAUDE2WEB_DEFAULT_MODEL || process.env.ANTHROPIC_MODEL || "";
    return (
      resolveModelSelection(this.#modelCatalog, persistedSelection || {}) ||
      resolveModelSelection(this.#modelCatalog, { model: requestedDefault }) ||
      this.#modelCatalog.find((option) => option.provider === "deepseek") ||
      this.#modelCatalog[0] ||
      {
        cliModel: "",
        id: "claude:default",
        label: "Claude: default",
        model: "default",
        provider: "claude",
        source: "fallback",
      }
    );
  }

  #getCurrentModelSelection(sessionId = this.#pinnedSessionId) {
    const effectiveSessionId = trimText(sessionId);
    if (effectiveSessionId) {
      const sessionSelection = this.#modelSelectionsBySession.get(effectiveSessionId);
      if (sessionSelection) {
        return sessionSelection;
      }
    }
    if (!this.#modelSelection) {
      this.#modelSelection = this.#resolveInitialModelSelection(null);
    }
    return this.#modelSelection;
  }

  async #refreshReadiness() {
    const checkedAt = nowIso();
    const versionResult = await runClaudeCommand({
      args: ["--version"],
      binaryPath: this.#claudeBinaryPath,
      cwd: os.tmpdir(),
      timeoutMs: 10000,
    });

    if (versionResult.error || versionResult.code !== 0) {
      this.#sendReadiness = {
        ...this.#sendReadiness,
        checkedAt,
        reason: `Claude binary check failed: ${
          versionResult.error?.message || summarizeProcessOutput(versionResult.stdout, versionResult.stderr) || "unknown error"
        }`,
        runtimeReady: false,
        sendReady: false,
        version: "",
      };
      return;
    }

    const version = trimText(versionResult.stdout) || trimText(versionResult.stderr);
    if (!this.#sendRequested) {
      this.#sendReadiness = {
        ...this.#sendReadiness,
        checkedAt,
        reason: "Claude send is disabled. Set CLAUDE2WEB_ENABLE_SEND=true in the lab service to run the real send probe.",
        runtimeReady: true,
        sendReady: false,
        version,
      };
      return;
    }

    const probe = await this.#runSendProbe();
    this.#sendReadiness = {
      binaryPath: this.#claudeBinaryPath,
      checkedAt: nowIso(),
      reason: probe.ok ? "Claude send probe passed." : probe.reason,
      runtimeReady: true,
      sendReady: probe.ok,
      sendRequested: true,
      version,
    };
  }

  async #runSendProbe() {
    const probeId = randomUUID();
    const expected = "CLAUDE2WEB_SEND_PROBE_OK";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude2web-send-probe-"));
    const currentModel = this.#getCurrentModelSelection();
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      probeId,
    ];
    if (currentModel?.cliModel) {
      args.push("--model", currentModel.cliModel);
    }
    args.push(`Reply exactly: ${expected}`);

    try {
      const result = await runClaudeCommand({
        args,
        binaryPath: this.#claudeBinaryPath,
        cwd: tempDir,
        env: createClaudeExecutionEnv(currentModel, tempDir),
        timeoutMs: SEND_PROBE_TIMEOUT_MS,
      });

      if (result.error) {
        return {
          ok: false,
          reason: `Claude send probe failed to start: ${result.error.message}`,
        };
      }

      if (result.timedOut) {
        return {
          ok: false,
          reason: "Claude send probe timed out before proving transport readiness.",
        };
      }

      if (result.code !== 0) {
        return {
          ok: false,
          reason: `Claude send probe exited with code ${String(result.code)}: ${summarizeProcessOutput(
            result.stdout,
            result.stderr,
          )}`,
        };
      }

      if (!result.stdout.includes(expected)) {
        return {
          ok: false,
          reason: `Claude send probe did not return the expected marker: ${summarizeProcessOutput(
            result.stdout,
            result.stderr,
          )}`,
        };
      }

      return {
        ok: true,
        reason: "Claude send probe passed.",
      };
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  async #startSendProcess(session, prompt, { imageAnalyses = [], imagePaths = [], logicalSession = null, resume = true } = {}) {
    let accepted = false;
    let timeoutId = null;
    const requestedCwd = session.resumePath || session.projectPath;
    const recentReadableDirs = await inferRecentTranscriptReadableDirs(session);

    return new Promise((resolve, reject) => {
      const currentModel = this.#getCurrentModelSelection(logicalSession?.id || session.id);
      const imageMode = currentModel.provider === "deepseek" ? "ocr" : "native";
      const promptWithImages = buildClaudePromptWithImages(prompt, imagePaths, {
        imageAnalyses,
        imageMode,
      });
      const readableDirs = Array.from(new Set([
        session.projectPath,
        ...recentReadableDirs,
        ...imagePaths.map((filePath) => path.dirname(filePath)).filter(Boolean),
      ]));
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        ...readableDirs,
      ];
      if (currentModel?.cliModel) {
        args.push("--model", currentModel.cliModel);
      }
      if (resume) {
        args.push("--resume", session.id);
      } else {
        args.push("--session-id", session.id);
      }
      const child = spawn(
        this.#claudeBinaryPath,
        args,
        {
          cwd: requestedCwd,
          env: createClaudeExecutionEnv(currentModel, requestedCwd),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const runContext = {
        acceptedAt: null,
        child,
        lastVisibleMessageAt: null,
        lastToolActivity: null,
        logicalSessionId: logicalSession?.id || session.id,
        startedAt: nowIso(),
        stallWatchdogTimer: null,
        stopEscalationTimer: null,
        stopRequested: false,
      };
      this.#activeSendRuns.set(session.id, runContext);
      this.#setRunExecutionState(session, runContext, {
        lastActivityAt: nowIso(),
        phase: "starting",
        pid: child.pid || null,
        processAlive: true,
        statusDetail: child.pid
          ? `Claude 执行进程已启动（PID ${String(child.pid)}），模型 ${currentModel.model}，${recentReadableDirs.length > 0 ? `已补充 ${String(recentReadableDirs.length)} 个近期工作区授权，` : ""}${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`
          : `Claude 执行进程已启动，模型 ${currentModel.model}，${recentReadableDirs.length > 0 ? `已补充 ${String(recentReadableDirs.length)} 个近期工作区授权，` : ""}${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`,
      }, { emit: false });
      this.#emit("state", this.getBinding());
      this.#startRunWatchdog(session, runContext);

      const accept = () => {
        if (accepted) {
          return;
        }

        accepted = true;
        runContext.acceptedAt = nowIso();
        this.#setRunExecutionState(session, runContext, {
          acceptedAt: runContext.acceptedAt,
          lastActivityAt: nowIso(),
          phase: runContext.stopRequested ? "stopping" : "running",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested
            ? "停止请求已发出，等待 Claude 进程退出。"
            : imagePaths.length > 0
              ? `指令和 ${String(imagePaths.length)} 张图片已被 Claude 接收，等待输出进入信息流。`
              : "指令已被 Claude 接收，等待输出进入信息流。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
        resolve({ imageCount: imagePaths.length, sessionId: runContext.logicalSessionId });
      };

      const fail = (message) => {
        if (runContext.stopRequested) {
          if (!accepted) {
            accept();
          }
          return;
        }

        this.#setRunExecutionState(session, runContext, {
          lastActivityAt: nowIso(),
          phase: "failed",
          pid: child.pid || null,
          processAlive: false,
          statusDetail: message,
        }, { emit: false });
        this.#emit("state", this.getBinding());

        if (accepted) {
          this.#emit("sendFailure", { message, sessionId: runContext.logicalSessionId, time: nowIso() });
          return;
        }

        reject(new BridgeError(502, message, "SEND_FAILED"));
      };

      timeoutId = setTimeout(() => {
        accept();
      }, SEND_ACCEPT_TIMEOUT_MS);
      timeoutId.unref?.();

      let stderrText = "";
      let stdoutText = "";
      let streamRemainder = "";
      let modelEvidence = null;

      const recordToolActivity = (record) => {
        const toolActivity = extractClaudeToolActivity(record);
        if (!toolActivity) {
          return;
        }

        const visibleAt = record?.timestamp || nowIso();
        runContext.lastToolActivity = {
          detail: toolActivity.detail || "",
          name: toolActivity.name || "工具",
          status: toolActivity.status || "running",
          summary: toolActivity.summary || toolActivity.text || "",
          time: visibleAt,
        };
        this.#setRunExecutionState(session, runContext, {
          lastActivityAt: visibleAt,
          lastToolActivity: runContext.lastToolActivity,
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: `${toolActivity.status === "running" ? "正在执行" : toolActivity.status === "background" ? "后台运行" : "刚完成"} ${toolActivity.name}：${toolActivity.summary}`,
        }, { emit: false });
      };

      const recordModelEvidence = (record) => {
        const evidence = extractExecutionModelEvidence(record);
        if (!evidence) {
          return;
        }

        modelEvidence = evidence;
        this.#setRunExecutionState(session, runContext, {
          actualModel: evidence.actualModel || null,
          lastActivityAt: nowIso(),
          modelUsage: evidence.modelUsage,
          modelUsageModels: evidence.modelUsageModels,
          selectedModel: {
            cliModel: currentModel.cliModel,
            label: currentModel.label,
            model: currentModel.model,
            provider: currentModel.provider,
          },
          statusDetail: formatExecutionModelDetail(currentModel, evidence),
        }, { emit: false });
      };

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        this.#finishRun(session.id, runContext);
        fail(`Claude send failed to start: ${String(error.message || error)}`);
      });

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        stdoutText += text;
        const lines = `${streamRemainder}${text}`.split("\n");
        streamRemainder = lines.pop() || "";
        for (const line of lines) {
          const parsed = safeJsonParse(line);
          if (parsed) {
            recordToolActivity(parsed);
            recordModelEvidence(parsed);
          }
        }
        this.#setRunExecutionState(session, runContext, {
          lastActivityAt: nowIso(),
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested
            ? "停止请求已发出，等待 Claude 进程退出。"
            : accepted
              ? formatExecutionModelDetail(currentModel, modelEvidence)
              : "Claude 进程已有输出，等待确认接收。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
        clearTimeout(timeoutId);
        accept();
      });

      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString("utf-8");
        this.#setRunExecutionState(session, runContext, {
          lastActivityAt: nowIso(),
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested ? "停止请求已发出，等待 Claude 进程退出。" : "Claude 进程有新的运行日志。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
      });

      child.on("close", async (code) => {
        clearTimeout(timeoutId);
        const trailingRecord = safeJsonParse(streamRemainder);
        if (trailingRecord) {
          recordToolActivity(trailingRecord);
          recordModelEvidence(trailingRecord);
        }
        modelEvidence = modelEvidence || extractExecutionModelEvidenceFromOutput(stdoutText);
        const selectedModel = {
          cliModel: currentModel.cliModel,
          label: currentModel.label,
          model: currentModel.model,
          provider: currentModel.provider,
        };

        try {
          await this.#pollSession(session, runContext);
        } catch (error) {
          process.stderr.write(`Failed to poll final Claude transcript output: ${String(error)}\n`);
        }

        if (runContext.stopRequested) {
          const detail = code === 0 ? "Claude 执行已停止。" : `Claude 执行已停止（退出码 ${String(code)}）。`;
          this.#setRunExecutionState(session, runContext, {
            actualModel: modelEvidence?.actualModel || null,
            exitCode: code,
            lastActivityAt: nowIso(),
            modelUsage: modelEvidence?.modelUsage || null,
            modelUsageModels: modelEvidence?.modelUsageModels || [],
            phase: "idle",
            pid: child.pid || null,
            processAlive: false,
            selectedModel,
            statusDetail: `${detail} ${formatExecutionModelDetail(currentModel, modelEvidence)} 可继续发送。`,
          }, { emit: false });
          this.#emit("stop", {
            message: detail,
            sessionId: runContext.logicalSessionId,
            status: "stopped",
            time: nowIso(),
          });
          this.#emit("state", this.getBinding());
          if (!accepted) {
            accept();
          }
          this.#finishRun(session.id, runContext);
          return;
        }

        if (code === 0) {
          const backgroundActivity = runContext.lastToolActivity?.status === "background"
            ? runContext.lastToolActivity
            : null;
          this.#setRunExecutionState(session, runContext, {
            actualModel: modelEvidence?.actualModel || null,
            exitCode: 0,
            lastActivityAt: nowIso(),
            lastToolActivity: backgroundActivity || runContext.lastToolActivity || null,
            modelUsage: modelEvidence?.modelUsage || null,
            modelUsageModels: modelEvidence?.modelUsageModels || [],
            phase: backgroundActivity ? "background" : "idle",
            pid: child.pid || null,
            processAlive: false,
            selectedModel,
            statusDetail: backgroundActivity
              ? `Claude 主执行已结束，但后台任务仍在运行：${backgroundActivity.summary}。${formatExecutionModelDetail(currentModel, modelEvidence)}`
              : `Claude 执行已完成，${formatExecutionModelDetail(currentModel, modelEvidence)} 可继续发送下一条指令。`,
          }, { emit: false });
          this.#emit("state", this.getBinding());
          if (!accepted) {
            accept();
          }
          this.#finishRun(session.id, runContext);
          return;
        }

        this.#finishRun(session.id, runContext);
        fail(`Claude send exited with code ${String(code)}: ${summarizeProcessOutput(stdoutText, stderrText)}`);
      });

      child.stdin.write(promptWithImages);
      child.stdin.end();
    });
  }

  async #refreshSessions(force = false) {
    const shouldRefresh =
      force || Date.now() - this.#lastSessionRefreshAt >= SESSION_REFRESH_TTL_MS || this.#sessions.length === 0;

    if (!shouldRefresh) {
      return;
    }

    const files = await listJsonlFiles(this.#sessionRootPath);
    const sessions = [];

    for (const filePath of files) {
      if (isSubagentTranscriptFile(filePath)) {
        continue;
      }

      const session = await readClaudeSessionMetadata(filePath);
      if (session.id) {
        sessions.push(session);
      }
    }

    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const uniqueSessions = [];
    const seenSessionIds = new Set();
    for (const session of sessions) {
      if (seenSessionIds.has(session.id)) {
        continue;
      }

      seenSessionIds.add(session.id);
      uniqueSessions.push(session);
    }

    this.#sessions = uniqueSessions;
    this.#sessionsById = new Map(uniqueSessions.map((session) => [session.id, session]));
    this.#lastSessionRefreshAt = Date.now();
  }

  #startPolling() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
    }

    this.#pollTimer = setInterval(() => {
      this.#scheduleReadinessRetry();
      void this.#pollActiveSessions();
    }, SESSION_POLL_INTERVAL_MS);
    this.#pollTimer.unref?.();
  }

  #scheduleReadinessRetry() {
    if (!this.#sendRequested || this.#sendReadiness.sendReady || this.#readinessRefreshInFlight || this.#readinessRetryTimer) {
      return;
    }

    this.#readinessRetryTimer = setTimeout(() => {
      this.#readinessRetryTimer = null;
      this.#readinessRefreshInFlight = this.#refreshReadiness()
        .then(() => {
          this.#emit("state", this.getBinding());
        })
        .finally(() => {
          this.#readinessRefreshInFlight = null;
        });
    }, SEND_READINESS_RETRY_MS);
    this.#readinessRetryTimer.unref?.();
  }

  async #pollActiveSessions() {
    const sessions = [];
    const pinned = this.#getSession(this.#pinnedSessionId);
    if (pinned) {
      sessions.push(pinned);
    }
    for (const session of this.#ephemeralSessionsById.values()) {
      sessions.push(session);
    }

    for (const session of sessions) {
      await this.#pollSession(session);
    }
  }

  async #pollSession(session) {
    if (!session || !session.filePath) {
      return;
    }

    const runContext = this.#activeSendRuns.get(session.id);
    const logicalSession = this.#getLogicalSession(session, runContext);
    const outputSessionId = logicalSession.id;
    let cursor = this.#sessionCursors.get(session.id);
    if (!cursor) {
      if (runContext?.logicalSessionId && runContext.logicalSessionId !== session.id) {
        cursor = {
          emittedIds: new Set(),
          nextLineNumber: 1,
          offset: 0,
          remainder: "",
        };
        this.#sessionCursors.set(session.id, cursor);
      } else {
        await this.getTranscript(session.id);
        cursor = this.#sessionCursors.get(session.id);
        if (!cursor) {
          return;
        }
      }
    }

    let fileInfo;
    try {
      fileInfo = await stat(session.filePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (fileInfo.size < cursor.offset) {
      await this.getTranscript(session.id);
      this.#emit("state", this.getBinding());
      return;
    }

    if (fileInfo.size === cursor.offset) {
      return;
    }

    const chunk = await readJsonlSlice(session.filePath, cursor.offset, fileInfo.size - cursor.offset);
    const combined = `${cursor.remainder}${chunk}`;
    const lines = combined.split("\n");
    cursor.remainder = lines.pop() ?? "";

    const transcript = this.#transcriptCache.get(outputSessionId) || [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const record = safeJsonParse(line);
      const lineNumber = cursor.nextLineNumber;
      cursor.nextLineNumber += 1;
      if (!record) {
        continue;
      }

      const entry = normalizeClaudeRecord(outputSessionId, record, lineNumber);
      if (!entry || cursor.emittedIds.has(entry.id)) {
        continue;
      }

      cursor.emittedIds.add(entry.id);
      const visibleEntry = outputSessionId !== session.id
        ? namespaceLogicalBranchEntryId(entry, session.id)
        : entry;
      transcript.push(visibleEntry);
      if (outputSessionId !== session.id) {
        await this.#appendLogicalTranscriptEntry(outputSessionId, visibleEntry);
        await this.#advanceDeepSeekRunSyncedEntry(outputSessionId, session.id, visibleEntry.id);
      }
      if (transcript.length > DEFAULT_TRANSCRIPT_LIMIT) {
        transcript.splice(0, transcript.length - DEFAULT_TRANSCRIPT_LIMIT);
      }
      const executionState = runContext ? this.#executionStateBySession.get(outputSessionId) : null;
      if (executionState && (executionState.phase === "starting" || executionState.phase === "running")) {
        const visibleAt = entry.time || nowIso();
        const toolActivity = entry.toolActivity
          ? {
              detail: entry.toolActivity.detail || "",
              name: entry.toolActivity.name || "工具",
              status: entry.toolActivity.status || "running",
              summary: entry.toolActivity.summary || visibleEntry.text || "",
              time: visibleAt,
            }
          : null;
        if (runContext) {
          if (toolActivity) {
            runContext.lastToolActivity = toolActivity;
          } else {
            runContext.lastVisibleMessageAt = visibleAt;
          }
        }
        this.#setExecutionState(outputSessionId, {
          lastActivityAt: visibleAt,
          lastToolActivity: toolActivity || executionState.lastToolActivity || null,
          lastVisibleMessageAt: toolActivity ? executionState.lastVisibleMessageAt || null : visibleAt,
          phase: "running",
          processAlive: true,
          statusDetail: toolActivity
            ? `${toolActivity.status === "running" ? "正在执行" : toolActivity.status === "background" ? "后台运行" : "刚完成"} ${toolActivity.name}：${toolActivity.summary}`
            : "Claude 执行中，已收到新的可见输出。",
        }, { emit: false });
      }
      this.#emit("message", { entry: visibleEntry, sessionId: outputSessionId });
    }

    cursor.offset = fileInfo.size;
    this.#transcriptCache.set(outputSessionId, transcript);
  }

  #emit(type, payload) {
    this.#events.emit("event", { payload, type });
  }

  #recordAudit({ action, detail, nextSessionId, prevSessionId }) {
    const entry = {
      action,
      detail,
      nextSessionId,
      prevSessionId,
      time: nowIso(),
    };
    this.#auditTrail.push(entry);
    if (this.#auditTrail.length > 500) {
      this.#auditTrail.splice(0, this.#auditTrail.length - 500);
    }
    this.#emit("audit", entry);
    void this.#persistAuditEntry(entry);
  }

  #getSession(sessionId) {
    if (!sessionId) {
      return null;
    }

    return this.#sessionsById.get(sessionId) || this.#ephemeralSessionsById.get(sessionId) || null;
  }

  #toPublicSession(session) {
    return {
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      providerId: "claude",
      updatedAt: session.updatedAt,
    };
  }

  #getProviderRunSessionState(logicalSessionId) {
    if (!logicalSessionId) {
      return null;
    }
    const sessions = this.#providerRuns.sessions && typeof this.#providerRuns.sessions === "object"
      ? this.#providerRuns.sessions
      : {};
    return sessions[logicalSessionId] && typeof sessions[logicalSessionId] === "object"
      ? sessions[logicalSessionId]
      : null;
  }

  #getDeepSeekRun(logicalSessionId) {
    const sessionState = this.#getProviderRunSessionState(logicalSessionId);
    const run = sessionState?.providers?.deepseek;
    return run && typeof run === "object" ? run : null;
  }

  async #getReusableDeepSeekRun(logicalSessionId, transcript) {
    const run = this.#getDeepSeekRun(logicalSessionId);
    if (!run || run.status !== "ready" || !trimText(run.sessionId) || !trimText(run.filePath)) {
      return null;
    }

    try {
      await stat(run.filePath);
    } catch {
      return null;
    }

    const latestEntryId = Array.isArray(transcript) ? transcript.at(-1)?.id || null : null;
    if (latestEntryId && run.lastSyncedLogicalEntryId && latestEntryId !== run.lastSyncedLogicalEntryId) {
      return null;
    }

    return {
      ...run,
      filePath: run.filePath,
      sessionId: run.sessionId,
    };
  }

  async #setDeepSeekRunInitializing(logicalSessionId, { filePath, lastSyncedLogicalEntryId, sessionId, sourcePhysicalSessionId }) {
    if (!logicalSessionId || !sessionId) {
      return;
    }

    const now = nowIso();
    const sessions = this.#providerRuns.sessions && typeof this.#providerRuns.sessions === "object"
      ? this.#providerRuns.sessions
      : {};
    const sessionState = sessions[logicalSessionId] && typeof sessions[logicalSessionId] === "object"
      ? sessions[logicalSessionId]
      : {};
    const providers = sessionState.providers && typeof sessionState.providers === "object" ? sessionState.providers : {};
    sessions[logicalSessionId] = {
      ...sessionState,
      activeProvider: "deepseek",
      providers: {
        ...providers,
        deepseek: {
          createdAt: providers.deepseek?.createdAt || now,
          filePath,
          lastSyncedLogicalEntryId: lastSyncedLogicalEntryId || null,
          provider: "deepseek",
          sessionId,
          sourcePhysicalSessionId: sourcePhysicalSessionId || logicalSessionId,
          status: "initializing",
          updatedAt: now,
        },
      },
    };
    this.#providerRuns = { sessions, updatedAt: now };
    await this.#persistProviderRuns();
  }

  async #markDeepSeekRunReady(logicalSessionId, sessionId) {
    const run = this.#getDeepSeekRun(logicalSessionId);
    if (!run || run.sessionId !== sessionId) {
      return;
    }

    run.status = "ready";
    run.updatedAt = nowIso();
    await this.#persistProviderRuns();
  }

  async #markDeepSeekRunFailed(logicalSessionId, sessionId, status = "failed") {
    const run = this.#getDeepSeekRun(logicalSessionId);
    if (!run || run.sessionId !== sessionId) {
      return;
    }

    run.status = status;
    run.updatedAt = nowIso();
    await this.#persistProviderRuns();
  }

  async #advanceDeepSeekRunSyncedEntry(logicalSessionId, sessionId, entryId) {
    const run = this.#getDeepSeekRun(logicalSessionId);
    if (!run || run.sessionId !== sessionId || !entryId) {
      return;
    }

    run.lastSyncedLogicalEntryId = entryId;
    run.updatedAt = nowIso();
    await this.#persistProviderRuns();
  }

  async #syncDeepSeekRunTranscript(logicalSessionId) {
    const run = this.#getDeepSeekRun(logicalSessionId);
    if (!run || !trimText(run.sessionId) || !trimText(run.filePath)) {
      return 0;
    }

    let raw;
    try {
      raw = await readFile(run.filePath, "utf-8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    const existingEntries = await this.#readLogicalTranscript(logicalSessionId, { limit: HISTORY_TRANSCRIPT_LIMIT });
    const existingKeys = new Set(existingEntries.map((entry) => transcriptContentKey(entry)).filter(Boolean));
    let appendedCount = 0;
    let latestSyncedEntryId = "";
    let lineNumber = 0;

    for (const line of raw.split("\n")) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }

      const record = safeJsonParse(line);
      if (!record) {
        continue;
      }

      const entry = normalizeClaudeRecord(logicalSessionId, record, lineNumber);
      if (!entry) {
        continue;
      }

      const visibleEntry = namespaceLogicalBranchEntryId(entry, run.sessionId);
      if (isInternalProviderScaffoldText(visibleEntry.text)) {
        continue;
      }

      const contentKey = transcriptContentKey(visibleEntry);
      latestSyncedEntryId = visibleEntry.id;
      if (!contentKey || existingKeys.has(contentKey)) {
        continue;
      }

      await this.#appendLogicalTranscriptEntry(logicalSessionId, visibleEntry);
      existingKeys.add(contentKey);
      appendedCount += 1;
    }

    if (appendedCount > 0 && latestSyncedEntryId) {
      await this.#advanceDeepSeekRunSyncedEntry(logicalSessionId, run.sessionId, latestSyncedEntryId);
    }

    return appendedCount;
  }

  #getLogicalTranscriptPath(sessionId) {
    const safeSessionId = safeFileName(sessionId);
    if (!safeSessionId) {
      return "";
    }
    return path.join(this.#logicalTranscriptDir, `${safeSessionId}.jsonl`);
  }

  async #readLogicalTranscript(sessionId, { limit = DEFAULT_TRANSCRIPT_LIMIT } = {}) {
    const filePath = this.#getLogicalTranscriptPath(sessionId);
    if (!filePath) {
      return [];
    }

    let raw;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.#logicalTranscriptPersistedIds.set(sessionId, new Set());
        return [];
      }
      throw error;
    }

    const entries = [];
    const persistedIds = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const entry = normalizeLogicalTranscriptEntry(safeJsonParse(line));
      if (!entry || persistedIds.has(entry.id)) {
        continue;
      }
      persistedIds.add(entry.id);
      entries.push(entry);
    }
    this.#logicalTranscriptPersistedIds.set(sessionId, persistedIds);
    return entries.slice(-Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TRANSCRIPT_LIMIT));
  }

  async #appendLogicalTranscriptEntry(sessionId, entry) {
    const normalized = normalizeLogicalTranscriptEntry(entry);
    if (!sessionId || !normalized || isInternalProviderScaffoldText(normalized.text)) {
      return;
    }

    let persistedIds = this.#logicalTranscriptPersistedIds.get(sessionId);
    if (!persistedIds) {
      await this.#readLogicalTranscript(sessionId);
      persistedIds = this.#logicalTranscriptPersistedIds.get(sessionId) || new Set();
    }
    if (persistedIds.has(normalized.id)) {
      return;
    }

    persistedIds.add(normalized.id);
    this.#logicalTranscriptPersistedIds.set(sessionId, persistedIds);
    await mkdir(this.#logicalTranscriptDir, { recursive: true });
    await appendFile(this.#getLogicalTranscriptPath(sessionId), `${JSON.stringify(normalized)}\n`, "utf-8");
  }

  async #persistPinnedSessionId() {
    if (!this.#pinnedSessionId) {
      return;
    }

    const dir = path.dirname(this.#stateFilePath);
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        modelSelection: this.#modelSelection || this.#resolveInitialModelSelection(null),
        sessionModelSelections: Object.fromEntries(this.#modelSelectionsBySession.entries()),
        pinnedSessionId: this.#pinnedSessionId,
        providerId: "claude",
        updatedAt: nowIso(),
      },
      null,
      2,
    );
    await writeFile(this.#stateFilePath, payload, "utf-8");
  }

  async #persistAuditEntry(entry) {
    try {
      if (!this.#auditFilePath) {
        return;
      }

      await mkdir(path.dirname(this.#auditFilePath), { recursive: true });
      await appendFile(this.#auditFilePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      process.stderr.write(`Failed to persist Claude audit entry: ${String(error)}\n`);
    }
  }

  async #persistProviderRuns() {
    try {
      await mkdir(path.dirname(this.#providerRunsFilePath), { recursive: true });
      await writeFile(this.#providerRunsFilePath, JSON.stringify(this.#providerRuns, null, 2), "utf-8");
    } catch (error) {
      process.stderr.write(`Failed to persist Claude provider runs: ${String(error)}\n`);
    }
  }

  async #readPersistedProviderRuns() {
    try {
      const parsed = JSON.parse(await readFile(this.#providerRunsFilePath, "utf-8"));
      const sessions = parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
      this.#providerRuns = {
        sessions,
        updatedAt: trimText(parsed?.updatedAt) || null,
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        process.stderr.write(`Failed to load Claude provider runs: ${String(error)}\n`);
      }
      this.#providerRuns = { sessions: {} };
    }
  }

  async #readPersistedState() {
    try {
      const raw = await readFile(this.#stateFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.providerId === "claude") {
        return {
          modelSelection: parsed.modelSelection && typeof parsed.modelSelection === "object" ? parsed.modelSelection : null,
          pinnedSessionId: typeof parsed.pinnedSessionId === "string" && parsed.pinnedSessionId ? parsed.pinnedSessionId : null,
          sessionModelSelections: parsed.sessionModelSelections && typeof parsed.sessionModelSelections === "object"
            ? parsed.sessionModelSelections
            : {},
        };
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        process.stderr.write(`Failed to load persisted Claude session pin: ${String(error)}\n`);
      }
    }

    return {
      modelSelection: null,
      pinnedSessionId: null,
      sessionModelSelections: {},
    };
  }
}
