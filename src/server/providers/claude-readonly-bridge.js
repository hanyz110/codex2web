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
const TRANSCRIPT_TAIL_INITIAL_READ_BYTES = 512 * 1024;
const TRANSCRIPT_TAIL_MAX_READ_BYTES = 24 * 1024 * 1024;
const SEND_ACCEPT_TIMEOUT_MS = 1500;
const SEND_PROBE_TIMEOUT_MS = readPositiveDuration(process.env.CLAUDE2WEB_SEND_PROBE_TIMEOUT_MS, 90000);
const SEND_READINESS_RETRY_MS = readPositiveDuration(process.env.CLAUDE2WEB_SEND_READINESS_RETRY_MS, 60000);
const SEND_TIMEOUT_MS = 600000;
const SESSION_POLL_INTERVAL_MS = 1200;
const SESSION_REFRESH_TTL_MS = 5000;
const STOP_ESCALATION_TIMEOUT_MS = 3000;
const DEEPSEEK_FORK_CONTEXT_LIMIT = 12;
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

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
    cliModel: normalizedProvider === "deepseek" ? getDeepSeekClaudeCliAlias(normalizedModel) : normalizedModel,
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

async function discoverDynamicModelCatalog() {
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
  if (lower === "opus" || lower.includes("opus-4-7")) return 10;
  if (lower === "sonnet" || lower.includes("sonnet-4-6")) return 11;
  if (lower === "haiku" || lower.includes("haiku-4-5")) return 12;
  if (lower.includes("opus-4-6")) return 13;
  return 30;
}

export function resolveModelSelection(catalog, request = {}) {
  const requestObject = request && typeof request === "object" ? request : {};
  const requestedProvider = normalizeModelName(requestObject.provider).toLowerCase();
  const requestedModel = normalizeModelName(
    requestObject.model || requestObject.id || requestObject.cliModel || (typeof request === "string" ? request : ""),
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

function createClaudeExecutionEnv(selection) {
  const nextEnv = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  };

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

function formatTranscriptRole(role) {
  return role === "assistant" ? "Assistant" : "User";
}

function isDeepSeekSafeForkScaffoldText(text) {
  const value = trimText(text);
  return value.startsWith("这是一个自动创建的 DeepSeek 安全分支。");
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

async function readTranscriptTail(filePath, fileSize) {
  const maxReadBytes = Math.min(fileSize, TRANSCRIPT_TAIL_MAX_READ_BYTES);
  let readBytes = Math.min(fileSize, TRANSCRIPT_TAIL_INITIAL_READ_BYTES);

  while (readBytes <= maxReadBytes) {
    const offset = Math.max(0, fileSize - readBytes);
    const raw = await readJsonlSlice(filePath, offset, fileSize - offset);
    const lines = raw.split("\n").filter((line) => line.trim());
    if (offset === 0 || lines.length >= DEFAULT_TRANSCRIPT_LIMIT * 3 || readBytes >= maxReadBytes) {
      return { offset, raw };
    }

    readBytes = Math.min(maxReadBytes, readBytes * 2);
  }

  return { offset: 0, raw: "" };
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

async function parseClaudeTranscriptFile(session) {
  const fileInfo = await stat(session.filePath);
  const { offset, raw } = await readTranscriptTail(session.filePath, fileInfo.size);
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

  const trimmed = transcript.slice(-DEFAULT_TRANSCRIPT_LIMIT);
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

function buildClaudePromptWithImages(prompt, imagePaths, imageAnalyses = []) {
  const cleanPrompt = trimText(prompt);
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return cleanPrompt;
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
    "已附加图片。注意：当前 Claude2Web 使用 DeepSeek Anthropic 兼容接口，官方不支持原生 image content，因此服务端已先对图片执行 OCR，并把可读文本作为上下文提供。",
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
  #pinnedSessionId = null;
  #pollTimer = null;
  #readinessRefreshInFlight = null;
  #readinessRetryTimer = null;
  #sendReadiness;
  #sendRequested;
  #sendingSessionIds = new Set();
  #sessionCursors = new Map();
  #sessionRootPath;
  #sessions = [];
  #sessionsById = new Map();
  #stateFilePath;
  #transcriptCache = new Map();

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
  }

  async init() {
    await this.#refreshModelCatalog();
    await this.#refreshSessions(true);
    const persistedState = await this.#readPersistedState();
    this.#modelSelection = this.#resolveInitialModelSelection(persistedState?.modelSelection);
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

  getProviderInfo() {
    const currentModel = this.#getCurrentModelSelection();
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
    return this.#sessions.map((session) => this.#toPublicSession(session));
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

  getExecutionPolicy() {
    return {
      cliArgs: [],
      displayName: this.#sendReadiness.sendReady ? "Claude Lab Send" : "Claude Readiness Gated",
      profile: this.#sendReadiness.sendReady ? "claude-lab-send" : "readonly",
      source: "provider",
      summary: this.#sendReadiness.sendReady
        ? `Claude send is enabled with ${this.#getCurrentModelSelection().label}. Use /model or the page model switcher to change models.`
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

    const previousSelection = this.#getCurrentModelSelection();
    this.#modelSelection = nextSelection;
    await this.#persistPinnedSessionId();
    this.#recordAudit({
      action: "model_switch",
      detail: `Model switched from ${previousSelection.provider}:${previousSelection.model} to ${nextSelection.provider}:${nextSelection.model}.`,
      nextSessionId: this.#pinnedSessionId,
      prevSessionId: this.#pinnedSessionId,
    });

	    if (this.#sendRequested) {
	      await this.#refreshReadiness();
	    }

	    const executionState = this.#executionStateBySession.get(this.#pinnedSessionId);
	    if (executionState && executionState.phase !== "starting" && executionState.phase !== "running" && executionState.phase !== "stopping") {
	      this.#setExecutionState(this.#pinnedSessionId, {
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

	    this.#emit("state", this.getBinding());
	    return {
      model: this.getProviderInfo().model,
      provider: this.getProviderInfo(),
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
      lastVisibleMessageAt: null,
      actualModel: null,
      modelUsage: null,
      modelUsageModels: [],
      phase: "idle",
      pid: null,
      processAlive: false,
      selectedModel: this.#getCurrentModelSelection(),
      sessionId: sessionId || null,
      startedAt: null,
      statusDetail: this.#sendReadiness.sendReady
        ? `Claude lab send is ready. 当前模型：${this.#getCurrentModelSelection().label}。`
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
  }

  #requestRunStop(session, runContext, { detail, phase = "stopping", status = "stopping" } = {}) {
    if (!session?.id || !runContext?.child || runContext.child.exitCode != null) {
      return false;
    }

    const message = trimText(detail) || "停止请求已发出，等待 Claude 进程退出。";
    runContext.stopRequested = true;
    this.#setExecutionState(session.id, {
      lastActivityAt: nowIso(),
      phase,
      pid: runContext.child.pid || null,
      processAlive: true,
      statusDetail: message,
    }, { emit: false });
    this.#emit("stop", {
      message,
      sessionId: session.id,
      status,
      time: nowIso(),
    });
    this.#emit("state", this.getBinding());

    const signaled = runContext.child.kill("SIGINT");
    if (!signaled) {
      runContext.stopRequested = false;
      this.#emit("stop", {
        message: "停止失败：无法向 Claude 进程发送中断信号。",
        sessionId: session.id,
        status: "stop-failed",
        time: nowIso(),
      });
      this.#setExecutionState(session.id, {
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
      const runtimeMs = Number.isFinite(startedAtMs) ? now - startedAtMs : 0;
      const quietVisibleMs = Number.isFinite(lastVisibleAtMs) ? now - lastVisibleAtMs : 0;

      if (runtimeMs >= EXECUTION_MAX_RUNTIME_MS) {
        this.#requestRunStop(session, runContext, {
          detail: `Claude 执行已超过 ${Math.round(EXECUTION_MAX_RUNTIME_MS / 60000)} 分钟上限，已自动停止并释放发送锁。`,
          status: "stopping",
        });
        return;
      }

      if (quietVisibleMs >= EXECUTION_VISIBLE_OUTPUT_STALL_MS) {
        this.#requestRunStop(session, runContext, {
          detail: `Claude 执行已超过 ${Math.round(EXECUTION_VISIBLE_OUTPUT_STALL_MS / 60000)} 分钟没有新的可见输出，已自动停止并释放发送锁。`,
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

  getBinding() {
    const session = this.#getSession(this.#pinnedSessionId);
    const executionState = this.#getExecutionState(this.#pinnedSessionId);
    const isSending = this.#sendingSessionIds.has(this.#pinnedSessionId);
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
      execution: this.getExecutionPolicy(),
      executionState,
      pinnedSessionId: this.#pinnedSessionId,
      provider: this.getProviderInfo(),
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
    const { cursor, transcript } = parsedTranscript;
    this.#sessionCursors.set(sessionId, cursor);
    this.#transcriptCache.set(sessionId, transcript);
    return transcript.map((entry) => ({ ...entry }));
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

  async attachSession(sessionId, explicit) {
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
    this.#pinnedSessionId = target.id;
    await this.#persistPinnedSessionId();
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
    this.#emit("state", this.getBinding());

    return this.getBinding();
  }

  async sendInput(message, options = {}) {
    const trimmed = trimText(message);
    const imagePaths = Array.isArray(options?.imagePaths)
      ? options.imagePaths.map((filePath) => normalizePath(filePath)).filter(Boolean)
      : [];
    const imageAnalyses = Array.isArray(options?.imageAnalyses) ? options.imageAnalyses : [];
    const modelCommand = parseModelCommand(trimmed);
    if (modelCommand) {
      if (!modelCommand.requested) {
        return {
          message: formatModelList(this.#modelCatalog, this.#getCurrentModelSelection()),
          model: this.getProviderInfo().model,
          modelCommand: true,
          sessionId: this.#pinnedSessionId,
        };
      }
      const result = await this.setModelSelection({ model: modelCommand.requested });
      return {
        message: `模型已切换为 ${result.model.current.model} (${result.model.current.provider})。`,
        model: result.model,
        modelCommand: true,
        sessionId: this.#pinnedSessionId,
      };
    }

    if (!trimmed || trimmed.length < 2) {
      throw new BridgeError(400, "Message must be at least 2 characters.", "INVALID_MESSAGE");
    }

    await this.#refreshSessions(true);
    const session = this.#getSession(this.#pinnedSessionId);
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

    const target = await this.#prepareSessionForCurrentModel(session, trimmed);

    this.#sendingSessionIds.add(target.session.id);
    this.#setExecutionState(target.session.id, {
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
      selectedModel: this.#getCurrentModelSelection(),
      startedAt: nowIso(),
      statusDetail: target.forked
        ? `原 session 含 Claude thinking 历史，已创建 DeepSeek 安全分支 ${target.session.id.slice(0, 8)}，正在带入最近上下文执行。`
        : imagePaths.length > 0
          ? `指令已发送，已附加 ${String(imagePaths.length)} 张图片，正在启动 Claude resume。`
          : "指令已发送，正在启动 Claude resume。",
    }, { emit: false });
    this.#emit("state", this.getBinding());

    try {
      const result = await this.#startSendProcess(target.session, target.prompt, {
        imageAnalyses,
        imagePaths,
        resume: !target.forked,
      });
      return {
        ...result,
        acceptedAt: nowIso(),
        forked: target.forked,
        imageCount: imagePaths.length,
      };
    } catch (error) {
      this.#sendingSessionIds.delete(target.session.id);
      this.#emit("state", this.getBinding());
      throw error;
    }
  }

  async stopInput() {
    const session = this.#getSession(this.#pinnedSessionId);
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

    const runContext = this.#activeSendRuns.get(session.id);
    if (!runContext?.child) {
      throw new BridgeError(409, "Claude execution process is missing.", "STOP_FAILED");
    }

    const signaled = this.#requestRunStop(session, runContext, {
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

  async #prepareSessionForCurrentModel(session, prompt) {
    const currentModel = this.#getCurrentModelSelection();
    if (currentModel.provider !== "deepseek") {
      return {
        forked: false,
        prompt,
        session,
      };
    }

    const thinkingState = await inspectClaudeSessionThinking(session.filePath);
    if (!thinkingState.hasThinking) {
      return {
        forked: false,
        prompt,
        session,
      };
    }

    const transcript = await this.getTranscript(session.id);
    const nextSessionId = randomUUID();
    const nextSession = {
      filePath: path.join(path.dirname(session.filePath), `${nextSessionId}.jsonl`),
      id: nextSessionId,
      name: `DeepSeek 安全分支 · ${session.name}`,
      projectPath: session.projectPath,
      resumePath: session.resumePath,
      updatedAt: nowIso(),
    };
    const forkPrompt = buildDeepSeekSafeForkPrompt({
      latestPrompt: prompt,
      sourceSessionId: session.id,
      transcript,
    });
    const detail = `原 session 含 Claude thinking 历史，已自动创建 DeepSeek 安全分支 ${nextSession.id.slice(0, 8)}，并带入最近 ${String(Math.min(transcript.length, DEEPSEEK_FORK_CONTEXT_LIMIT))} 条可见上下文继续执行。`;

    this.#pinnedSessionId = nextSession.id;
    this.#sessions = [nextSession, ...this.#sessions];
    this.#sessionsById.set(nextSession.id, nextSession);
    await this.#persistPinnedSessionId();
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
      prompt: forkPrompt,
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
    this.#modelCatalog = await discoverDynamicModelCatalog();
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

  #getCurrentModelSelection() {
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
        env: createClaudeExecutionEnv(currentModel),
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

  async #startSendProcess(session, prompt, { imageAnalyses = [], imagePaths = [], resume = true } = {}) {
    let accepted = false;
    let timeoutId = null;

    return new Promise((resolve, reject) => {
      const currentModel = this.#getCurrentModelSelection();
      const promptWithImages = buildClaudePromptWithImages(prompt, imagePaths, imageAnalyses);
      const readableDirs = Array.from(new Set([
        session.projectPath,
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
          cwd: session.resumePath || session.projectPath,
          env: createClaudeExecutionEnv(currentModel),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const runContext = {
        acceptedAt: null,
        child,
        lastVisibleMessageAt: null,
        startedAt: nowIso(),
        stallWatchdogTimer: null,
        stopEscalationTimer: null,
        stopRequested: false,
      };
      this.#activeSendRuns.set(session.id, runContext);
      this.#setExecutionState(session.id, {
        lastActivityAt: nowIso(),
        phase: "starting",
        pid: child.pid || null,
        processAlive: true,
        statusDetail: child.pid
          ? `Claude 执行进程已启动（PID ${String(child.pid)}），模型 ${currentModel.model}，${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`
          : `Claude 执行进程已启动，模型 ${currentModel.model}，${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`,
      }, { emit: false });
      this.#emit("state", this.getBinding());
      this.#startRunWatchdog(session, runContext);

      const accept = () => {
        if (accepted) {
          return;
        }

        accepted = true;
        runContext.acceptedAt = nowIso();
        this.#setExecutionState(session.id, {
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
        resolve({ imageCount: imagePaths.length, sessionId: session.id });
      };

      const fail = (message) => {
        if (runContext.stopRequested) {
          if (!accepted) {
            accept();
          }
          return;
        }

        this.#setExecutionState(session.id, {
          lastActivityAt: nowIso(),
          phase: "failed",
          pid: child.pid || null,
          processAlive: false,
          statusDetail: message,
        }, { emit: false });
        this.#emit("state", this.getBinding());

        if (accepted) {
          this.#emit("sendFailure", { message, sessionId: session.id, time: nowIso() });
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

      const recordModelEvidence = (record) => {
        const evidence = extractExecutionModelEvidence(record);
        if (!evidence) {
          return;
        }

        modelEvidence = evidence;
        this.#setExecutionState(session.id, {
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
            recordModelEvidence(parsed);
          }
        }
        this.#setExecutionState(session.id, {
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
        this.#setExecutionState(session.id, {
          lastActivityAt: nowIso(),
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested ? "停止请求已发出，等待 Claude 进程退出。" : "Claude 进程有新的运行日志。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        this.#finishRun(session.id, runContext);
        const trailingRecord = safeJsonParse(streamRemainder);
        if (trailingRecord) {
          recordModelEvidence(trailingRecord);
        }
        modelEvidence = modelEvidence || extractExecutionModelEvidenceFromOutput(stdoutText);
        const selectedModel = {
          cliModel: currentModel.cliModel,
          label: currentModel.label,
          model: currentModel.model,
          provider: currentModel.provider,
        };

        if (runContext.stopRequested) {
          const detail = code === 0 ? "Claude 执行已停止。" : `Claude 执行已停止（退出码 ${String(code)}）。`;
          this.#setExecutionState(session.id, {
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
            sessionId: session.id,
            status: "stopped",
            time: nowIso(),
          });
          this.#emit("state", this.getBinding());
          if (!accepted) {
            accept();
          }
          return;
        }

        if (code === 0) {
          this.#setExecutionState(session.id, {
            actualModel: modelEvidence?.actualModel || null,
            exitCode: 0,
            lastActivityAt: nowIso(),
            modelUsage: modelEvidence?.modelUsage || null,
            modelUsageModels: modelEvidence?.modelUsageModels || [],
            phase: "idle",
            pid: child.pid || null,
            processAlive: false,
            selectedModel,
            statusDetail: `Claude 执行已完成，${formatExecutionModelDetail(currentModel, modelEvidence)} 可继续发送下一条指令。`,
          }, { emit: false });
          this.#emit("state", this.getBinding());
          if (!accepted) {
            accept();
          }
          return;
        }

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
      void this.#pollPinnedSession();
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

  async #pollPinnedSession() {
    const session = this.#getSession(this.#pinnedSessionId);
    if (!session || !session.filePath) {
      return;
    }

    let cursor = this.#sessionCursors.get(session.id);
    if (!cursor) {
      await this.getTranscript(session.id);
      cursor = this.#sessionCursors.get(session.id);
      if (!cursor) {
        return;
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

    const transcript = this.#transcriptCache.get(session.id) || [];
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

      const entry = normalizeClaudeRecord(session.id, record, lineNumber);
      if (!entry || cursor.emittedIds.has(entry.id)) {
        continue;
      }

      cursor.emittedIds.add(entry.id);
      transcript.push(entry);
      if (transcript.length > DEFAULT_TRANSCRIPT_LIMIT) {
        transcript.splice(0, transcript.length - DEFAULT_TRANSCRIPT_LIMIT);
      }
      const executionState = this.#executionStateBySession.get(session.id);
      if (executionState && (executionState.phase === "starting" || executionState.phase === "running")) {
        const visibleAt = entry.time || nowIso();
        const runContext = this.#activeSendRuns.get(session.id);
        if (runContext) {
          runContext.lastVisibleMessageAt = visibleAt;
        }
        this.#setExecutionState(session.id, {
          lastActivityAt: visibleAt,
          lastVisibleMessageAt: visibleAt,
          phase: "running",
          processAlive: true,
          statusDetail: "Claude 执行中，已收到新的可见输出。",
        }, { emit: false });
      }
      this.#emit("message", { entry, sessionId: session.id });
    }

    cursor.offset = fileInfo.size;
    this.#transcriptCache.set(session.id, transcript);
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

    return this.#sessionsById.get(sessionId) || null;
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

  async #persistPinnedSessionId() {
    if (!this.#pinnedSessionId) {
      return;
    }

    const dir = path.dirname(this.#stateFilePath);
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        modelSelection: this.#getCurrentModelSelection(),
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

  async #readPersistedState() {
    try {
      const raw = await readFile(this.#stateFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.providerId === "claude") {
        return {
          modelSelection: parsed.modelSelection && typeof parsed.modelSelection === "object" ? parsed.modelSelection : null,
          pinnedSessionId: typeof parsed.pinnedSessionId === "string" && parsed.pinnedSessionId ? parsed.pinnedSessionId : null,
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
    };
  }
}
