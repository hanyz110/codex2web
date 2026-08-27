import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  forkCodexThread,
  isThreadActiveWriterConflict,
  isThreadWriterLockHeld,
} from "./codex-app-server.js";
import {
  collectMappedForkSessionIds,
  parseSessionForkMappings,
  resolveMappedSessionId,
  serializeSessionForkMappings,
} from "./session-forks.js";

export function getDefaultCodexBinaryCandidates(homeDir = os.homedir()) {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(homeDir, ".nvm", "versions", "node", "v22.20.0", "bin", "codex"),
    path.join(homeDir, ".bun", "bin", "codex"),
  ];
}
const DEFAULT_TRANSCRIPT_LIMIT = 300;
const HISTORY_TRANSCRIPT_LIMIT = 3000;
const FIRST_JSONL_RECORD_READ_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_INITIAL_READ_BYTES = 512 * 1024;
const TRANSCRIPT_TAIL_MAX_READ_BYTES = 24 * 1024 * 1024;
const MAX_TRANSPORT_ERROR_DETAIL_CHARS = 1200;
const SEND_START_TIMEOUT_MS = 30000;
const STOP_ESCALATION_TIMEOUT_MS = 3000;
const STOP_STATUS_RESET_MS = 6000;
const SESSION_POLL_INTERVAL_MS = 1200;
const SESSION_REFRESH_TTL_MS = 5000;
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
const TRANSCRIPT_DUPLICATE_WINDOW_MS = 2000;

export class BridgeError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "BridgeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

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

function normalizeTranscriptText(value) {
  return trimText(value).replace(/\s+/g, " ");
}

function parseEntryTime(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDuplicateTranscriptEntry(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.role !== right.role) {
    return false;
  }

  if (normalizeTranscriptText(left.text) !== normalizeTranscriptText(right.text)) {
    return false;
  }

  const leftTime = parseEntryTime(left.time);
  const rightTime = parseEntryTime(right.time);
  return leftTime > 0 && rightTime > 0 && Math.abs(leftTime - rightTime) <= TRANSCRIPT_DUPLICATE_WINDOW_MS;
}

function hasRecentDuplicateTranscriptEntry(entries, candidate) {
  const recentEntries = entries.slice(-8);
  return recentEntries.some((entry) => isDuplicateTranscriptEntry(entry, candidate));
}

function dedupeTranscriptEntries(entries) {
  const deduped = [];
  for (const entry of entries) {
    if (!hasRecentDuplicateTranscriptEntry(deduped, entry)) {
      deduped.push(entry);
    }
  }
  return deduped;
}

function normalizePath(value) {
  const trimmed = trimText(value);
  if (!trimmed) {
    return "";
  }

  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function parseCodexVersion(output) {
  const match = String(output || "").match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
    raw: match[0],
  };
}

function compareCodexVersions(left, right) {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }

  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return 1;
  }
  if (!right.prerelease) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease);
}

function getCodexBinaryVersion(binaryPath) {
  if (!binaryPath || !existsSync(binaryPath)) {
    return null;
  }

  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  });
  if (result.status !== 0) {
    return null;
  }

  return parseCodexVersion(`${result.stdout || ""}\n${result.stderr || ""}`);
}

function resolveDefaultCodexBinary() {
  let selected = null;
  for (const candidate of getDefaultCodexBinaryCandidates()) {
    const version = getCodexBinaryVersion(candidate);
    if (!version) {
      continue;
    }

    if (!selected || compareCodexVersions(version, selected.version) > 0) {
      selected = { path: candidate, version };
    }
  }

  return selected?.path || path.join(os.homedir(), ".bun", "bin", "codex");
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractContentText(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "input_text" || block.type === "output_text") {
      const text = trimText(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n\n").trim();
}

function isHumanEventMessage(record) {
  return (
    record?.type === "event_msg" &&
    (record.payload?.type === "user_message" || record.payload?.type === "agent_message")
  );
}

function normalizeRecord(sessionId, record, lineNumber, preferEventMessages) {
  if (preferEventMessages && isHumanEventMessage(record)) {
    const role = record.payload.type === "user_message" ? "user" : "assistant";
    const text = trimText(record.payload.message);
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

  if (preferEventMessages) {
    return null;
  }

  if (record?.type !== "response_item" || record.payload?.type !== "message") {
    return null;
  }

  const role = record.payload.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const text = extractContentText(record.payload.content);
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

async function readFirstJsonlRecord(filePath) {
  const raw = await readJsonlSlice(filePath, 0, FIRST_JSONL_RECORD_READ_BYTES);
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? safeJsonParse(firstLine) : null;
}

function formatTransportExitMessage(code, stderrText) {
  const detail = trimText(stderrText)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n")
    .slice(0, MAX_TRANSPORT_ERROR_DETAIL_CHARS);

  return detail
    ? `Send transport exited with code ${String(code)}. ${detail}`
    : `Send transport exited with code ${String(code)}.`;
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
    if (
      offset === 0 ||
      lines.length >= minimumLineCount ||
      readBytes >= maxReadBytes
    ) {
      return { offset, raw };
    }

    readBytes = Math.min(maxReadBytes, readBytes * 2);
  }

  return { offset: 0, raw: "" };
}

async function loadSessionIndex(indexPath) {
  let raw = "";

  try {
    raw = await readFile(indexPath, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }

  const metadata = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse(line);
    if (!parsed?.id) {
      continue;
    }

    metadata.set(parsed.id, {
      threadName: trimText(parsed.thread_name) || `Session ${String(parsed.id).slice(0, 8)}`,
      updatedAt: parsed.updated_at || null,
    });
  }

  return metadata;
}

async function parseTranscriptFile(session, { limit = DEFAULT_TRANSCRIPT_LIMIT } = {}) {
  const fileInfo = await stat(session.filePath);
  const safeLimit = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_TRANSCRIPT_LIMIT);
  const { offset, raw } = await readTranscriptTail(session.filePath, fileInfo.size, safeLimit * 3);
  const records = [];
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

    records.push({ lineNumber, record: parsed });
  }

  const preferEventMessages = records.some((item) => isHumanEventMessage(item.record));
  const transcript = [];

  for (const item of records) {
    const entry = normalizeRecord(session.id, item.record, item.lineNumber, preferEventMessages);
    if (entry) {
      transcript.push(entry);
    }
  }

  const trimmed = dedupeTranscriptEntries(transcript).slice(-safeLimit);
  return {
    cursor: {
      emittedIds: new Set(trimmed.map((entry) => entry.id)),
      nextLineNumber: lineNumber + 1,
      offset: fileInfo.size,
      remainder: "",
      useEventMessages: preferEventMessages,
    },
    transcript: trimmed,
  };
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
  return entries.findIndex(
    (entry) =>
      entry.role === anchor.role &&
      trimText(entry.text) === anchorText &&
      String(entry.time || "") === String(anchor.time || ""),
  );
}

export class LocalSessionBridge {
  #activeSendRuns = new Map();
  #auditFilePath;
  #auditTrail = [];
  #codexBinaryPath;
  #executionStateBySession = new Map();
  #executionPolicy;
  #events = new EventEmitter();
  #failureModes = {
    attach: false,
    connection: false,
    send: false,
  };
  #lastSessionRefreshAt = 0;
  #pinnedSessionId = null;
  #pollTimer = null;
  #projectPath;
  #sendingSessionIds = new Set();
  #stopStatusBySession = new Map();
  #stopStatusResetTimers = new Map();
  #sessionCursors = new Map();
  #sessionIndexPath;
  #sessionForkMappings = new Map();
  #sessionForksFilePath;
  #sessionFileInfoCache = new Map();
  #sessionRootPath;
  #sessions = [];
  #sessionsById = new Map();
  #stateFilePath;
  #transcriptCache = new Map();

  constructor({ auditFilePath, codexBinaryPath, executionPolicy, projectPath, sessionForksFilePath, stateFilePath }) {
    this.#auditFilePath = auditFilePath;
    this.#codexBinaryPath = normalizePath(codexBinaryPath) || resolveDefaultCodexBinary();
    this.#executionPolicy = {
      cliArgs: Array.isArray(executionPolicy?.cliArgs) ? executionPolicy.cliArgs.slice() : [],
      displayName: trimText(executionPolicy?.displayName) || "Implicit Default",
      profile: trimText(executionPolicy?.profile) || "implicit",
      summary: trimText(executionPolicy?.summary) || "Browser execution policy is not configured.",
      trustBoundary: trimText(executionPolicy?.trustBoundary) || "unknown",
    };
    this.#projectPath = normalizePath(projectPath);
    this.#sessionIndexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
    this.#sessionRootPath = path.join(os.homedir(), ".codex", "sessions");
    this.#sessionForksFilePath = sessionForksFilePath || path.join(path.dirname(stateFilePath), "session-forks.json");
    this.#stateFilePath = stateFilePath;
  }

  async init() {
    await this.#loadSessionForkMappings();
    await this.#refreshSessions(true);
    const persistedSessionId = await this.#readPersistedSessionId();
    const hasPersistedPin = this.#sessionsById.has(persistedSessionId);
    const fallbackSessionId = this.#sessions.length === 1 ? this.#sessions[0].id : null;
    this.#pinnedSessionId = hasPersistedPin ? persistedSessionId : fallbackSessionId;

    if (this.#pinnedSessionId) {
      await this.#persistPinnedSessionId();
      this.#recordAudit({
        action: "session_restore",
        detail: hasPersistedPin
          ? "Pinned session restored from local Codex session files."
          : "Only one local Codex session was available, so it was bound as the initial pinned session.",
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

  async discoverSessions() {
    await this.#refreshSessions();
    const hiddenForkSessionIds = collectMappedForkSessionIds(this.#sessionForkMappings);
    return this.#sessions
      .filter((session) => !hiddenForkSessionIds.has(session.id))
      .map((session) => this.#toPublicSession(session));
  }

  getFailureModes() {
    return { ...this.#failureModes };
  }

  getAuditTrail(limit = 30) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 30;
    return this.#auditTrail.slice(-safeLimit).reverse().map((entry) => ({ ...entry }));
  }

  getExecutionPolicy() {
    return {
      ...this.#executionPolicy,
      cliArgs: this.#executionPolicy.cliArgs.slice(),
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
      phase: "idle",
      pid: null,
      processAlive: false,
      sessionId: sessionId || null,
      startedAt: null,
      statusDetail: "",
      updatedAt: nowIso(),
    };
  }

  #getExecutionState(sessionId) {
    if (!sessionId) {
      return null;
    }

    const state = this.#executionStateBySession.get(sessionId);
    if (!state) {
      return this.#createDefaultExecutionState(sessionId);
    }

    return { ...state };
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

  #getStopStatus(sessionId) {
    const status = this.#stopStatusBySession.get(sessionId);
    if (!status) {
      return {
        message: "",
        status: "idle",
        time: null,
      };
    }

    return { ...status };
  }

  #setStopStatus(sessionId, status, message = "") {
    if (!sessionId) {
      return;
    }

    const time = nowIso();
    this.#stopStatusBySession.set(sessionId, {
      message: trimText(message),
      status,
      time,
    });

    const previousTimer = this.#stopStatusResetTimers.get(sessionId);
    if (previousTimer) {
      clearTimeout(previousTimer);
      this.#stopStatusResetTimers.delete(sessionId);
    }

    if (status === "stopped" || status === "stop-failed") {
      const timer = setTimeout(() => {
        this.#stopStatusBySession.set(sessionId, {
          message: "",
          status: "idle",
          time: nowIso(),
        });
        this.#stopStatusResetTimers.delete(sessionId);
        this.#emit("state", this.getBinding());
      }, STOP_STATUS_RESET_MS);
      timer.unref?.();
      this.#stopStatusResetTimers.set(sessionId, timer);
    }

    this.#emit("stop", {
      message: trimText(message),
      sessionId,
      status,
      time,
    });
    this.#emit("state", this.getBinding());
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

  #requestRunStop(session, runContext, { auditAction = "execution_stop", detail, phase = "stopping" } = {}) {
    if (!session?.id || !runContext?.child || runContext.child.exitCode != null) {
      return false;
    }

    const message = trimText(detail) || "停止请求已发出，等待执行进程退出。";
    runContext.stopRequested = true;
    this.#setExecutionState(session.id, {
      lastActivityAt: nowIso(),
      phase,
      processAlive: true,
      statusDetail: message,
    }, { emit: false });
    this.#setStopStatus(session.id, "stopping", message);
    this.#recordAudit({
      action: auditAction,
      detail: message,
      nextSessionId: session.id,
      prevSessionId: null,
    });

    const signaled = runContext.child.kill("SIGINT");
    if (!signaled) {
      runContext.stopRequested = false;
      this.#setStopStatus(session.id, "stop-failed", "停止失败：无法向执行进程发送中断信号。");
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
          auditAction: "execution_auto_stop_max_runtime",
          detail: `执行已超过 ${Math.round(EXECUTION_MAX_RUNTIME_MS / 60000)} 分钟上限，已自动停止并释放发送锁。`,
        });
        return;
      }

      if (quietVisibleMs >= EXECUTION_VISIBLE_OUTPUT_STALL_MS) {
        this.#requestRunStop(session, runContext, {
          auditAction: "execution_auto_stop_no_visible_output",
          detail: `执行已超过 ${Math.round(EXECUTION_VISIBLE_OUTPUT_STALL_MS / 60000)} 分钟没有新的可见输出，已自动停止并释放发送锁。`,
        });
        return;
      }

      runContext.stallWatchdogTimer = setTimeout(check, EXECUTION_STALL_WATCHDOG_INTERVAL_MS);
      runContext.stallWatchdogTimer.unref?.();
    };

    runContext.stallWatchdogTimer = setTimeout(check, EXECUTION_STALL_WATCHDOG_INTERVAL_MS);
    runContext.stallWatchdogTimer.unref?.();
  }

  setFailureMode(kind, enabled) {
    if (!(kind in this.#failureModes)) {
      throw new BridgeError(400, `Unknown failure kind: ${kind}`, "UNKNOWN_FAILURE_KIND");
    }

    this.#failureModes[kind] = Boolean(enabled);
    this.#emit("failureModes", this.getFailureModes());
    this.#emit("state", this.getBinding());
  }

  resetFailureModes() {
    this.#failureModes.attach = false;
    this.#failureModes.connection = false;
    this.#failureModes.send = false;
    this.#emit("failureModes", this.getFailureModes());
    this.#emit("state", this.getBinding());
  }

  getBinding(sessionId = this.#pinnedSessionId) {
    const requestedSessionId = trimText(sessionId) || this.#pinnedSessionId;
    const session = this.#getSession(requestedSessionId);
    const effectiveSessionId = session?.id || requestedSessionId;
    const connection = this.#failureModes.connection ? "error" : "connected";
    const attach = this.#failureModes.attach || !session ? "error" : "attached";
    const stream = this.#failureModes.connection ? "idle" : "streaming";
    const stopStatus = this.#getStopStatus(effectiveSessionId);
    const executionState = this.#getExecutionState(effectiveSessionId);
    const isSending = this.#sendingSessionIds.has(effectiveSessionId);
    const send = this.#failureModes.send
      ? "error"
      : executionState?.phase === "failed"
        ? "error"
      : isSending
        ? stopStatus.status === "stopping" || executionState?.phase === "stopping"
          ? "stopping"
          : "sending"
        : stopStatus.status === "stopped"
          ? "stopped"
          : stopStatus.status === "stop-failed"
            ? "error"
            : "idle";

    return {
      attach,
      connection,
      execution: this.getExecutionPolicy(),
      executionState,
      pinnedSessionId: effectiveSessionId,
      send,
      session: session ? this.#toPublicSession(session) : null,
      stream,
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
    const effectiveSessionId = session.id;

    const cachedTranscript = this.#transcriptCache.get(effectiveSessionId);
    const cachedCursor = this.#sessionCursors.get(effectiveSessionId);
    const cachedFileInfo = this.#sessionFileInfoCache.get(effectiveSessionId);
    if (cachedTranscript && cachedCursor && cachedFileInfo) {
      try {
        const fileInfo = await stat(session.filePath);
        if (
          fileInfo.size === cachedFileInfo.size &&
          fileInfo.mtimeMs === cachedFileInfo.mtimeMs
        ) {
          return cachedTranscript.map((entry) => ({ ...entry }));
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const { cursor, transcript } = await parseTranscriptFile(session);
    this.#sessionCursors.set(effectiveSessionId, cursor);
    this.#transcriptCache.set(effectiveSessionId, transcript);
    const fileInfo = await stat(session.filePath);
    this.#sessionFileInfoCache.set(effectiveSessionId, {
      mtimeMs: fileInfo.mtimeMs,
      size: fileInfo.size,
    });
    return transcript.map((entry) => ({ ...entry }));
  }

  async refreshTranscriptCache(sessionId = this.#pinnedSessionId) {
    if (!sessionId) {
      return [];
    }

    const session = this.#getSession(sessionId);
    if (!session) {
      return [];
    }
    await this.#pollSessionById(session.id);
    const transcript = this.#transcriptCache.get(session.id);
    if (transcript) {
      return transcript.map((entry) => ({ ...entry }));
    }

    return this.getTranscript(session.id);
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
    const effectiveSessionId = session.id;

    const transcript = await this.refreshTranscriptCache(effectiveSessionId);

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
    if (!session) {
      return {
        entries: [],
        hasMore: false,
        oldestEntryId: null,
      };
    }
    const effectiveSessionId = session.id;

    const safeLimit = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 80));
    const visibleTranscript = this.#transcriptCache.get(effectiveSessionId) || (await this.getTranscript(effectiveSessionId));
    const visibleAnchor = visibleTranscript.find((entry) => entry.id === beforeId) || { id: beforeId };
    const { transcript } = await parseTranscriptFile(session, { limit: HISTORY_TRANSCRIPT_LIMIT });
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
      detail: "User explicitly switched the pinned local Codex session.",
      nextSessionId: target.id,
      prevSessionId: previousPinnedSessionId,
    });
    this.#emit("pinned", {
      pinnedSessionId: target.id,
      session: this.#toPublicSession(target),
      updatedAt: nowIso(),
    });
    this.#emit("state", this.getBinding(options.persist === false ? target.id : undefined));

    return this.getBinding(options.persist === false ? target.id : undefined);
  }

  async sendInput(message, options = {}) {
    const trimmed = trimText(message);
    const attachmentPrompt = trimText(options?.attachmentPrompt) || trimmed;
    const imagePaths = Array.isArray(options?.imagePaths)
      ? options.imagePaths.map((filePath) => normalizePath(filePath)).filter(Boolean)
      : [];
    if (!trimmed || trimmed.length < 2) {
      throw new BridgeError(400, "Message must be at least 2 characters.", "INVALID_MESSAGE");
    }

    if (this.#failureModes.connection) {
      throw new BridgeError(503, "Bridge connection is down.", "CONNECTION_DOWN");
    }

    if (this.#failureModes.send) {
      throw new BridgeError(502, "Send transport failed.", "SEND_FAILED");
    }

    await this.#refreshSessions(true);
    const targetSessionId = trimText(options?.sessionId) || this.#pinnedSessionId;
    let session = this.#getSession(targetSessionId);
    if (this.#failureModes.attach || !session) {
      throw new BridgeError(409, "Pinned session is not attached.", "SESSION_ATTACH_ERROR");
    }

    if (!existsSync(session.filePath)) {
      throw new BridgeError(
        409,
        "当前 pinned session 对应的本地会话文件不存在，无法继续在原会话上发送。请切换到最近仍可用的 session 后重试。",
        "SESSION_FILE_MISSING",
      );
    }

    if (this.#sendingSessionIds.has(session.id)) {
      throw new BridgeError(
        409,
        "Pinned session is still processing the previous instruction.",
        "SEND_IN_PROGRESS",
      );
    }

    let autoForked = false;
    let sourceSessionId = null;
    if (isThreadWriterLockHeld(session.id)) {
      sourceSessionId = session.id;
      session = await this.#createWebContinuationSession(session);
      autoForked = true;
    }

    this.#setStopStatus(session.id, "idle");
    this.#setExecutionState(session.id, {
      acceptedAt: null,
      exitCode: null,
      lastActivityAt: nowIso(),
      lastVisibleMessageAt: null,
      phase: "starting",
      processAlive: false,
      startedAt: nowIso(),
      statusDetail:
        autoForked
          ? "检测到桌面端正在使用原会话，已复制完整上下文并发送到 Web 续接会话。"
          : imagePaths.length > 0
          ? `指令已发送，已附加 ${String(imagePaths.length)} 张图片，正在启动 Codex 执行。`
          : "指令已发送，正在启动 Codex 执行。",
    }, { emit: false });
    this.#sendingSessionIds.add(session.id);
    this.#emit("state", this.getBinding());

    try {
      let result;
      try {
        result = await this.#startResumeProcess(session, attachmentPrompt, { imagePaths });
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "THREAD_ACTIVE_WRITER") {
          throw error;
        }

        sourceSessionId = session.id;
        this.#sendingSessionIds.delete(session.id);
        this.#setExecutionState(session.id, {
          exitCode: error.statusCode,
          lastActivityAt: nowIso(),
          phase: "idle",
          processAlive: false,
          statusDetail: "检测到桌面端正在使用原会话，正在自动创建 Web 续接会话。",
        }, { emit: false });
        session = await this.#createWebContinuationSession(session);
        autoForked = true;
        this.#setStopStatus(session.id, "idle");
        this.#setExecutionState(session.id, {
          acceptedAt: null,
          exitCode: null,
          lastActivityAt: nowIso(),
          lastVisibleMessageAt: null,
          phase: "starting",
          processAlive: false,
          startedAt: nowIso(),
          statusDetail: "已复制完整会话上下文，正在重新发送原指令。",
        }, { emit: false });
        this.#sendingSessionIds.add(session.id);
        this.#emit("state", this.getBinding(session.id));
        result = await this.#startResumeProcess(session, attachmentPrompt, { imagePaths });
      }

      return {
        ...result,
        acceptedAt: nowIso(),
        autoForked,
        imageCount: imagePaths.length,
        sourceSessionId,
      };
    } catch (error) {
      this.#sendingSessionIds.delete(session.id);
      this.#emit("state", this.getBinding());
      throw error;
    }
  }

  async stopInput(options = {}) {
    await this.#refreshSessions(true);
    const targetSessionId = trimText(options?.sessionId) || this.#pinnedSessionId;
    const session = this.#getSession(targetSessionId);
    if (this.#failureModes.attach || !session) {
      throw new BridgeError(409, "Pinned session is not attached.", "SESSION_ATTACH_ERROR");
    }

    const currentStopStatus = this.#getStopStatus(session.id);
    if (!this.#sendingSessionIds.has(session.id)) {
      this.#setStopStatus(session.id, "idle");
      return {
        message: "当前没有正在执行的对话。",
        sessionId: session.id,
        status: "idle",
      };
    }

    if (currentStopStatus.status === "stopping") {
      return {
        message: "停止请求已发出，等待执行进程退出。",
        sessionId: session.id,
        status: "stopping",
      };
    }

    const runContext = this.#activeSendRuns.get(session.id);
    if (!runContext?.child) {
      this.#setStopStatus(session.id, "stop-failed", "执行进程状态缺失，无法安全中断。");
      return {
        message: "执行进程状态缺失，无法安全中断。",
        sessionId: session.id,
        status: "stop-failed",
      };
    }

    const signaled = this.#requestRunStop(session, runContext, {
      auditAction: "execution_user_stop",
      detail: "停止请求已发出，等待执行进程退出。",
    });

    if (!signaled) {
      return {
        message: "停止失败：无法向执行进程发送中断信号。",
        sessionId: session.id,
        status: "stop-failed",
      };
    }

    return {
      message: "停止请求已发出，等待执行进程退出。",
      sessionId: session.id,
      signal: "SIGINT",
      status: "stopping",
    };
  }

  async #startResumeProcess(session, prompt, { imagePaths = [] } = {}) {
    let accepted = false;
    let failed = false;
    let timeoutId = null;
    let stderrText = "";

    return new Promise((resolve, reject) => {
      const imageArgs = imagePaths.flatMap((filePath) => ["--image", filePath]);
      const child = spawn(
        this.#codexBinaryPath,
        [
          "exec",
          "resume",
          ...this.#executionPolicy.cliArgs,
          "--skip-git-repo-check",
          "--json",
          ...imageArgs,
          session.id,
          "-",
        ],
        {
          cwd: session.projectPath,
          env: {
            ...process.env,
            TERM: process.env.TERM || "xterm-256color",
          },
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
          ? `Codex 执行进程已启动（PID ${String(child.pid)}），${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`
          : `Codex 执行进程已启动，${imagePaths.length > 0 ? `已附加 ${String(imagePaths.length)} 张图片，` : ""}等待确认接收。`,
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
            ? "停止请求已发出，等待执行进程退出。"
            : imagePaths.length > 0
              ? `指令和 ${String(imagePaths.length)} 张图片已被 Codex 接收，等待输出进入信息流。`
              : "指令已被 Codex 接收，等待输出进入信息流。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
        resolve({ imageCount: imagePaths.length, sessionId: session.id });
      };

      const fail = (message, errorCode = "SEND_FAILED") => {
        if (failed) {
          return;
        }
        failed = true;
        if (runContext.stopRequested) {
          if (!accepted) {
            accept();
          }
          return;
        }

        if (accepted) {
          this.#setExecutionState(session.id, {
            lastActivityAt: nowIso(),
            phase: "failed",
            processAlive: false,
            statusDetail: message,
          }, { emit: false });
          this.#emit("state", this.getBinding());
          this.#emit("sendFailure", { message, sessionId: session.id, time: nowIso() });
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
        reject(new BridgeError(502, message, errorCode));
      };

      timeoutId = setTimeout(() => {
        if (child.exitCode == null) {
          child.kill("SIGTERM");
        }
        fail("Codex 执行进程启动超时，未确认接收指令。", "SEND_START_TIMEOUT");
      }, SEND_START_TIMEOUT_MS);

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        this.#finishRun(session.id, runContext);
        fail(`Send transport failed to start: ${String(error.message || error)}`);
      });

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        const activityAt = nowIso();
        this.#setExecutionState(session.id, {
          lastActivityAt: activityAt,
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested
            ? "停止请求已发出，等待执行进程退出。"
            : accepted
              ? "执行中，等待新的可见输出。"
              : "执行进程已有活动，等待确认接收。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
        if (
          text.includes('"turn.started"') ||
          text.includes('"thread.started"') ||
          text.includes('"item.completed"')
        ) {
          clearTimeout(timeoutId);
          accept();
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        stderrText = `${stderrText}${text}`.slice(-MAX_TRANSPORT_ERROR_DETAIL_CHARS * 2);
        this.#setExecutionState(session.id, {
          lastActivityAt: nowIso(),
          phase: accepted ? (runContext.stopRequested ? "stopping" : "running") : "starting",
          pid: child.pid || null,
          processAlive: true,
          statusDetail: runContext.stopRequested
            ? "停止请求已发出，等待执行进程退出。"
            : "执行进程有新的运行日志。",
        }, { emit: false });
        this.#emit("state", this.getBinding());
        process.stderr.write(chunk);
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        this.#finishRun(session.id, runContext);
        const stopStatus = this.#getStopStatus(session.id);
        const stopInProgress = runContext.stopRequested || stopStatus.status === "stopping";

        if (stopInProgress) {
          const detail =
            code === 0
              ? "当前执行已停止。"
              : `当前执行已停止（退出码 ${String(code)}）。`;
          this.#setExecutionState(session.id, {
            exitCode: code,
            lastActivityAt: nowIso(),
            phase: "idle",
            pid: child.pid || null,
            processAlive: false,
            statusDetail: `${detail} 可继续发送。`,
          }, { emit: false });
          this.#setStopStatus(session.id, "stopped", detail);
          if (!accepted) {
            accept();
          }
          return;
        }

        this.#emit("state", this.getBinding());

        if (code === 0) {
          this.#setExecutionState(session.id, {
            exitCode: 0,
            lastActivityAt: nowIso(),
            phase: "idle",
            pid: child.pid || null,
            processAlive: false,
            statusDetail: "当前执行已完成，可继续发送下一条指令。",
          }, { emit: false });
          this.#emit("state", this.getBinding());
          if (!accepted) {
            accept();
          }
          return;
        }

        const message = formatTransportExitMessage(code, stderrText);
        fail(
          message,
          isThreadActiveWriterConflict(stderrText) ? "THREAD_ACTIVE_WRITER" : "SEND_FAILED",
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  async #createWebContinuationSession(sourceSession) {
    let fork;
    try {
      fork = await forkCodexThread({
        codexBinaryPath: this.#codexBinaryPath,
        executionPolicy: this.#executionPolicy,
        session: sourceSession,
      });
    } catch (error) {
      throw new BridgeError(
        502,
        `检测到桌面端正在使用原会话，但自动创建 Web 续接会话失败：${String(error.message || error)}`,
        "WEB_CONTINUATION_FAILED",
      );
    }

    this.#sessionForkMappings.set(sourceSession.id, fork.sessionId);
    await this.#persistSessionForkMappings();
    await this.#refreshSessions(true);
    const continuationSession = this.#sessionsById.get(fork.sessionId);
    if (!continuationSession) {
      throw new BridgeError(
        502,
        "Web 续接会话已经创建，但本地会话索引尚未发现它，请重试。",
        "WEB_CONTINUATION_NOT_DISCOVERED",
      );
    }

    if (this.#pinnedSessionId === sourceSession.id) {
      this.#pinnedSessionId = continuationSession.id;
      await this.#persistPinnedSessionId();
    }
    this.#recordAudit({
      action: "session_auto_fork",
      detail: "Detected a Codex active-writer conflict and created a Web continuation with the complete thread history.",
      nextSessionId: continuationSession.id,
      prevSessionId: sourceSession.id,
    });
    this.#emit("pinned", {
      pinnedSessionId: continuationSession.id,
      session: this.#toPublicSession(continuationSession),
      updatedAt: nowIso(),
    });
    return continuationSession;
  }

  async #refreshSessions(force = false) {
    const shouldRefresh =
      force || Date.now() - this.#lastSessionRefreshAt >= SESSION_REFRESH_TTL_MS || this.#sessions.length === 0;

    if (!shouldRefresh) {
      return;
    }

    const sessionIndex = await loadSessionIndex(this.#sessionIndexPath);
    const files = await listJsonlFiles(this.#sessionRootPath);
    const sessions = [];

    for (const filePath of files) {
      const firstRecord = await readFirstJsonlRecord(filePath);
      if (firstRecord?.type !== "session_meta") {
        continue;
      }

      const sessionId = trimText(firstRecord.payload?.id);
      const projectPath = normalizePath(firstRecord.payload?.cwd);
      if (!sessionId || !projectPath) {
        continue;
      }

      const meta = sessionIndex.get(sessionId);
      const fileInfo = await stat(filePath);
      sessions.push({
        filePath,
        id: sessionId,
        name: meta?.threadName || `Session ${sessionId.slice(0, 8)}`,
        projectPath,
        updatedAt: meta?.updatedAt || fileInfo.mtime.toISOString(),
      });
    }

    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    this.#sessions = sessions;
    this.#sessionsById = new Map(sessions.map((session) => [session.id, session]));
    this.#lastSessionRefreshAt = Date.now();
  }

  #startPolling() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
    }

    this.#pollTimer = setInterval(() => {
      void this.#pollPinnedSession();
    }, SESSION_POLL_INTERVAL_MS);
    this.#pollTimer.unref?.();
  }

  async #pollPinnedSession() {
    await this.#pollSessionById(this.#pinnedSessionId);
  }

  async #pollSessionById(sessionId) {
    const session = this.#getSession(sessionId);
    if (!session) {
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
      return;
    }

    const previousFileInfo = this.#sessionFileInfoCache.get(session.id);
    this.#sessionFileInfoCache.set(session.id, {
      mtimeMs: fileInfo.mtimeMs,
      size: fileInfo.size,
    });

    if (fileInfo.size === cursor.offset && previousFileInfo?.mtimeMs === fileInfo.mtimeMs) {
      return;
    }

    const chunk = await readJsonlSlice(session.filePath, cursor.offset, fileInfo.size - cursor.offset);
    const combined = `${cursor.remainder}${chunk}`;
    const lines = combined.split("\n");
    cursor.remainder = lines.pop() ?? "";

    const transcript = this.#transcriptCache.get(session.id) || [];
    let executionStateChanged = false;
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

      const entry = normalizeRecord(session.id, record, lineNumber, cursor.useEventMessages);
      if (!entry || cursor.emittedIds.has(entry.id)) {
        continue;
      }

      cursor.emittedIds.add(entry.id);
      if (hasRecentDuplicateTranscriptEntry(transcript, entry)) {
        continue;
      }

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
          statusDetail: "执行中，已收到新的可见输出。",
        }, { emit: false });
        executionStateChanged = true;
      }
      this.#emit("message", { entry, sessionId: session.id });
    }

    cursor.offset = fileInfo.size;
    this.#transcriptCache.set(session.id, transcript);
    if (executionStateChanged) {
      this.#emit("state", this.getBinding());
    }
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

    const resolvedSessionId = resolveMappedSessionId(
      sessionId,
      this.#sessionForkMappings,
      new Set(this.#sessionsById.keys()),
    );
    return this.#sessionsById.get(resolvedSessionId) || this.#sessionsById.get(sessionId) || null;
  }

  #toPublicSession(session) {
    return {
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
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
        pinnedSessionId: this.#pinnedSessionId,
        updatedAt: nowIso(),
      },
      null,
      2,
    );
    await writeFile(this.#stateFilePath, payload, "utf-8");
  }

  async #persistSessionForkMappings() {
    if (!this.#sessionForksFilePath) {
      return;
    }
    await mkdir(path.dirname(this.#sessionForksFilePath), { recursive: true });
    await writeFile(
      this.#sessionForksFilePath,
      JSON.stringify(serializeSessionForkMappings(this.#sessionForkMappings), null, 2),
      "utf-8",
    );
  }

  async #persistAuditEntry(entry) {
    try {
      if (!this.#auditFilePath) {
        return;
      }

      await mkdir(path.dirname(this.#auditFilePath), { recursive: true });
      await appendFile(this.#auditFilePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      process.stderr.write(`Failed to persist audit entry: ${String(error)}\n`);
    }
  }

  async #readPersistedSessionId() {
    try {
      const raw = await readFile(this.#stateFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.pinnedSessionId === "string" && parsed.pinnedSessionId.length > 0) {
        return parsed.pinnedSessionId;
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        process.stderr.write(`Failed to load persisted session pin: ${String(error)}\n`);
      }
    }

    return null;
  }

  async #loadSessionForkMappings() {
    if (!this.#sessionForksFilePath) {
      return;
    }
    try {
      const payload = JSON.parse(await readFile(this.#sessionForksFilePath, "utf-8"));
      this.#sessionForkMappings = parseSessionForkMappings(payload);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        process.stderr.write(`Failed to load Web continuation mappings: ${String(error)}\n`);
      }
    }
  }
}
