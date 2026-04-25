const state = {
  attach: "error",
  auditTrail: [],
  connection: "connecting",
  executionState: null,
  failureModes: { attach: false, connection: false, send: false },
  pinnedSessionId: "",
  send: "idle",
  sessionName: "",
  sessionProjectPath: "",
  sessions: [],
  stream: "idle",
  systemMeta: null,
  transcript: [],
};

const labels = {
  attach: {
    attached: { className: "is-ok", summary: "已附着", text: "attached" },
    error: { className: "is-error", summary: "附着失败", text: "attach-error" },
  },
  connection: {
    connected: { className: "is-ok", summary: "已连接", text: "connected" },
    connecting: { className: "is-warn", summary: "连接中", text: "connecting" },
    error: { className: "is-error", summary: "连接异常", text: "connection-error" },
  },
  send: {
    idle: { className: "is-idle", summary: "可发送", text: "send-idle" },
    stopped: { className: "is-idle", summary: "已停止", text: "stopped" },
    sending: { className: "is-warn", summary: "发送中", text: "sending" },
    stopping: { className: "is-warn", summary: "停止中", text: "stopping" },
    error: { className: "is-error", summary: "发送失败", text: "send-error" },
  },
  stream: {
    streaming: { className: "is-ok", summary: "流正常", text: "streaming" },
    idle: { className: "is-idle", summary: "流空闲", text: "stream-idle" },
    error: { className: "is-error", summary: "流中断", text: "stream-error" },
  },
};

const transcriptList = document.querySelector("#transcriptList");
const transcriptEmpty = document.querySelector("#transcriptEmpty");
const jumpToLatestButton = document.querySelector("#jumpToLatestButton");
const composerForm = document.querySelector("#composerForm");
const composerInput = document.querySelector("#composerInput");
const sendButton = document.querySelector("#sendButton");
const sendButtonLabel = document.querySelector("#sendButtonLabel");
const sendButtonIconSend = sendButton?.querySelector(".action-icon-send");
const sendButtonIconStop = sendButton?.querySelector(".action-icon-stop");
const sendFeedback = document.querySelector("#sendFeedback");
const sendFeedbackMeta = document.querySelector("#sendFeedbackMeta");
const composerContext = document.querySelector("#composerContext");
const globalAlert = document.querySelector("#globalAlert");
const sessionName = document.querySelector("#sessionName");
const sessionIdentity = document.querySelector("#sessionIdentity");
const sessionProjectPath = document.querySelector("#sessionProjectPath");
const sessionProjectLabel = document.querySelector("#sessionProjectLabel");
const connectionSummary = document.querySelector("#connectionSummary");
const executionStatusPill = document.querySelector("#executionStatusPill");
const executionSummaryInline = document.querySelector("#executionSummaryInline");
const mobileStatusPill = document.querySelector("#mobileStatusPill");
const drawerSessionName = document.querySelector("#drawerSessionName");
const sessionCandidates = document.querySelector("#sessionCandidates");
const auditList = document.querySelector("#auditList");
const securityMode = document.querySelector("#securityMode");
const securityAuth = document.querySelector("#securityAuth");
const executionMode = document.querySelector("#executionMode");
const executionSummary = document.querySelector("#executionSummary");
const openDrawerButton = document.querySelector("#openDrawerButton");
const closeDrawerButton = document.querySelector("#closeDrawerButton");
const closeDrawerButtonMobile = document.querySelector("#closeDrawerButtonMobile");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const sessionDrawer = document.querySelector("#sessionDrawer");
const explicitSwitch = document.querySelector("#explicitSwitch");
const simulateReconnect = document.querySelector("#simulateReconnect");
const simulateDisconnect = document.querySelector("#simulateDisconnect");
const failureButtons = document.querySelectorAll("[data-failure]");
const drawerOpeners = document.querySelectorAll("[data-drawer-open]");
const composerShell = document.querySelector(".composer-shell");
const mainContent = document.querySelector("#main-content");
const bootLoading = document.querySelector("#bootLoading");
const bootLoadingTitle = document.querySelector("#bootLoadingTitle");
const bootLoadingCopy = document.querySelector("#bootLoadingCopy");
const operationLoading = document.querySelector("#operationLoading");
const operationLoadingText = document.querySelector("#operationLoadingText");

const badgeElements = {
  attach: document.querySelector("#attachBadge"),
  connection: document.querySelector("#connectionBadge"),
  send: document.querySelector("#sendBadge"),
  stream: document.querySelector("#streamBadge"),
};

const seenMessageIds = new Set();
const expandedProjectPaths = new Set();
let stream = null;
let hadStreamError = false;
let lastTransportActivityAt = 0;
let shouldStickToBottom = true;
let snapshotPollInFlight = false;
let snapshotPollMs = 0;
let snapshotPollTimer = null;
let transportWatchdogTimer = null;
let sessionsLoaded = false;
let sessionsLoadingPromise = null;
const COMPOSER_MIN_HEIGHT = 38;
const DRAWER_CLOSE_TRANSITION_MS = 240;
const MIN_OPERATION_LOADING_MS = 300;
const REQUEST_TIMEOUT_MS = 12000;
const BOOT_LOADING_MAX_MS = 15000;
const ALERT_AUTO_HIDE_BASE_MS = 3200;
const ALERT_AUTO_HIDE_ERROR_MS = 5600;
const EXTERNAL_IDLE_SNAPSHOT_POLL_MS = 2500;
const SEND_ACTIVE_SNAPSHOT_POLL_MS = 1200;
const STREAM_ERROR_SNAPSHOT_POLL_MS = 2000;
const EXTERNAL_WATCHDOG_INTERVAL_MS = 3000;
const EXTERNAL_STALE_SNAPSHOT_MS = 6000;
const EXTERNAL_STALE_RECONNECT_MS = 12000;
const EXECUTION_NO_OUTPUT_HINT_MS = 8000;
const EXECUTION_STALLED_HINT_MS = 20000;
let operationLoadingCount = 0;
let bootStage = "恢复会话";
let alertAutoHideTimerId = 0;

function setText(target, value) {
  if (target) {
    target.textContent = value;
  }
}

function setHidden(target, hidden) {
  if (target) {
    target.hidden = hidden;
  }
}

function setAttr(target, name, value) {
  if (target) {
    target.setAttribute(name, value);
  }
}

function toggleClass(target, className, force) {
  if (target) {
    target.classList.toggle(className, force);
  }
}

function ensureRequiredDom() {
  const missing = [
    ["#sessionName", sessionName],
    ["#connectionSummary", connectionSummary],
    ["#sendButton", sendButton],
    ["#sendFeedback", sendFeedback],
    ["#composerContext", composerContext],
  ]
    .filter(([, element]) => !element)
    .map(([selector]) => selector);

  if (missing.length === 0) {
    return true;
  }

  setAlert(`页面资源版本不一致，缺少节点：${missing.join(", ")}。请刷新页面重试。`);
  return false;
}

function isBindingPayload(binding) {
  return (
    binding &&
    typeof binding === "object" &&
    typeof binding.attach === "string" &&
    typeof binding.connection === "string" &&
    typeof binding.send === "string" &&
    typeof binding.stream === "string"
  );
}

function requireBinding(binding, context) {
  if (isBindingPayload(binding)) {
    return binding;
  }

  throw new Error(`${context} 返回了无效会话状态，可能是外网链路返回了过期或非 JSON 响应，请刷新页面重试。`);
}

function formatTime(isoString) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));
}

function basename(input) {
  return input.split(/[\\/]/).filter(Boolean).pop() || input;
}

function parseIsoTime(value) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function elapsedSince(value) {
  const timestamp = parseIsoTime(value);
  if (!timestamp) {
    return 0;
  }

  return Math.max(0, Date.now() - timestamp);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainMinutes} 分`;
}

function deriveExecutionFeedback() {
  const executionState = state.executionState;
  const connectionReady = state.connection === "connected";
  const statusDetail = executionState?.statusDetail || "";

  if (state.send === "stopping") {
    return {
      detail: statusDetail || "中断信号已发出，等待执行进程退出。",
      durationMs: 0,
      kind: "stopping",
      summary: "正在停止当前执行...",
    };
  }

  if (state.send === "stopped") {
    return {
      detail: statusDetail || "已停止当前执行，现在可以继续发送。",
      durationMs: 0,
      kind: "stopped",
      summary: "已停止当前执行，可继续发送。",
    };
  }

  if (state.send === "error") {
    return {
      detail: statusDetail || "请查看上方错误提示后重试。",
      durationMs: 0,
      kind: "error",
      summary: "发送失败，请检查错误提示后重试。",
    };
  }

  if (state.send === "sending") {
    if (!executionState) {
      return {
        detail: "浏览器已发出请求，正在等待 bridge 返回执行状态。",
        durationMs: 0,
        kind: "starting",
        summary: "指令已发送，正在建立执行...",
      };
    }

    if (executionState.phase === "starting") {
      const waitMs = elapsedSince(executionState.startedAt || executionState.updatedAt);
      return {
        detail: statusDetail || "指令已经发出，正在等待 Codex 接收。",
        durationMs: waitMs,
        kind: waitMs >= EXECUTION_NO_OUTPUT_HINT_MS ? "starting-slow" : "starting",
        summary: waitMs >= EXECUTION_NO_OUTPUT_HINT_MS ? "执行启动较慢，仍在等待接收..." : "指令已发送，正在启动执行...",
      };
    }

    if (executionState.phase === "running") {
      const noVisibleSince = elapsedSince(
        executionState.lastVisibleMessageAt || executionState.acceptedAt || executionState.startedAt,
      );
      const noActivitySince = elapsedSince(
        executionState.lastActivityAt || executionState.acceptedAt || executionState.startedAt,
      );

      if (
        executionState.processAlive &&
        noVisibleSince >= EXECUTION_STALLED_HINT_MS &&
        noActivitySince >= EXECUTION_STALLED_HINT_MS
      ) {
        return {
          detail: `最近 ${formatDuration(noVisibleSince)} 没有新输出，且执行进程没有新活动。建议点击停止后重试。`,
          durationMs: noVisibleSince,
          kind: "stalled",
          summary: "执行可能卡住，已长时间无输出",
        };
      }

      if (noVisibleSince >= EXECUTION_NO_OUTPUT_HINT_MS) {
        return {
          detail: `最近 ${formatDuration(noVisibleSince)} 没有新的可见消息，但执行进程仍在运行。`,
          durationMs: noVisibleSince,
          kind: "quiet",
          summary: "仍在执行，暂时没有新输出",
        };
      }

      return {
        detail: statusDetail || "信息流会自动刷新，无需手动刷新页面。",
        durationMs: noVisibleSince,
        kind: "running",
        summary: "正在执行并接收更新",
      };
    }
  }

  return {
    detail: connectionReady ? statusDetail : "等待实时连接恢复后继续同步状态。",
    durationMs: 0,
    kind: connectionReady ? "idle" : "disconnected",
    summary: connectionReady ? "就绪" : "等待连接恢复",
  };
}

function deriveHeaderExecutionState(feedback) {
  const executionState = state.executionState;
  const summary = String(feedback?.summary || "等待执行状态");
  const durationLabel =
    Number.isFinite(feedback?.durationMs) && feedback.durationMs > 0 ? ` · ${formatDuration(feedback.durationMs)}` : "";

  if (feedback?.kind === "error" || executionState?.phase === "failed") {
    return { label: "异常", state: "error", summary };
  }

  if (feedback?.kind === "stalled") {
    return { label: "疑似卡住", state: "warning", summary: `疑似卡住${durationLabel}` };
  }

  if (feedback?.kind === "quiet") {
    return { label: "执行中", state: "running", summary: `已无输出${durationLabel}` };
  }

  if (feedback?.kind === "stopping" || executionState?.phase === "stopping") {
    return { label: "停止中", state: "stopping", summary };
  }

  if (feedback?.kind === "starting" || feedback?.kind === "starting-slow") {
    return {
      label: "启动中",
      state: "starting",
      summary: feedback.kind === "starting-slow" ? `启动较慢${durationLabel}` : summary,
    };
  }

  if (feedback?.kind === "running" || state.send === "sending" || executionState?.phase === "running") {
    return { label: "执行中", state: "running", summary };
  }

  return { label: "空闲", state: "idle", summary };
}

function markTransportActivity() {
  lastTransportActivityAt = Date.now();
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInlineMarkdown(text) {
  const inlineCodeTokens = new Map();
  let formatted = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${inlineCodeTokens.size}@@`;
    inlineCodeTokens.set(token, `<code class="inline-code">${escapeHtml(code)}</code>`);
    return token;
  });

  const markdownLinkTokens = new Map();
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const token = `@@LINK_${markdownLinkTokens.size}@@`;
    const safeUrl = escapeHtml(url);
    markdownLinkTokens.set(
      token,
      `<a class="inline-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
    return token;
  });

  formatted = formatted
    .replace(/\bhttps?:\/\/[^\s<)]+/g, (url) => {
      const safeUrl = escapeHtml(url);
      return `<a class="inline-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  for (const [token, value] of markdownLinkTokens) {
    formatted = formatted.replaceAll(token, value);
  }

  for (const [token, value] of inlineCodeTokens) {
    formatted = formatted.replaceAll(token, value);
  }

  return formatted;
}

function renderTextBlocks(text) {
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) {
    return "";
  }

  return blocks
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trimEnd());

      if (lines.every((line) => /^[-*]\s+/.test(line))) {
        const items = lines
          .map((line) => line.replace(/^[-*]\s+/, ""))
          .map((line) => `<li>${formatInlineMarkdown(line)}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      if (lines.every((line) => /^\d+\.\s+/.test(line))) {
        const items = lines
          .map((line) => line.replace(/^\d+\.\s+/, ""))
          .map((line) => `<li>${formatInlineMarkdown(line)}</li>`)
          .join("");
        return `<ol>${items}</ol>`;
      }

      if (lines.every((line) => /^>\s?/.test(line))) {
        const quote = lines.map((line) => line.replace(/^>\s?/, "")).join("<br>");
        return `<blockquote>${formatInlineMarkdown(quote)}</blockquote>`;
      }

      return `<p>${lines.map((line) => formatInlineMarkdown(line)).join("<br>")}</p>`;
    })
    .join("");
}

function renderMessageHtml(text) {
  const sections = text.split(/```/);

  return sections
    .map((section, index) => {
      if (index % 2 === 1) {
        const lines = section.replace(/^\n/, "").split("\n");
        const language = lines[0]?.trim() || "code";
        const code = lines.slice(1).join("\n").replace(/\n$/, "");
        const codeContent = escapeHtml(code || section.trim());
        return [
          '<div class="code-block">',
          '<div class="code-header">',
          `<span class="code-language">${escapeHtml(language)}</span>`,
          '<button class="code-copy-button" type="button" data-copy-state="idle" aria-label="复制代码">复制</button>',
          "</div>",
          `<pre><code>${codeContent}</code></pre>`,
          "</div>",
        ].join("");
      }

      return renderTextBlocks(section);
    })
    .join("");
}

function isNearBottom() {
  return transcriptList.scrollHeight - transcriptList.scrollTop - transcriptList.clientHeight < 56;
}

function updateJumpToLatestVisibility() {
  jumpToLatestButton.hidden = shouldStickToBottom || state.transcript.length === 0;
}

function scrollTranscriptToBottom() {
  transcriptList.scrollTop = transcriptList.scrollHeight;
  shouldStickToBottom = true;
  updateJumpToLatestVisibility();
}

function setDrawer(open) {
  toggleClass(sessionDrawer, "is-open", open);
  setAttr(sessionDrawer, "aria-hidden", String(!open));
  setAttr(openDrawerButton, "aria-expanded", String(open));
  setHidden(drawerBackdrop, !open);
}

function setBadge(kind, value) {
  const target = badgeElements[kind];
  if (!target) {
    return;
  }
  const config = labels[kind][value] || labels[kind].error;
  target.className = `badge ${config.className}`;
  setText(target, config.text);
}

function setAlert(message) {
  if (alertAutoHideTimerId) {
    window.clearTimeout(alertAutoHideTimerId);
    alertAutoHideTimerId = 0;
  }

  if (!message) {
    setHidden(globalAlert, true);
    setText(globalAlert, "");
    return;
  }

  setHidden(globalAlert, false);
  setText(globalAlert, message);

  const isErrorLikeAlert = /失败|错误|中断|超时|异常|阻止|停止/i.test(message);
  const autoHideDelay = isErrorLikeAlert ? ALERT_AUTO_HIDE_ERROR_MS : ALERT_AUTO_HIDE_BASE_MS;

  alertAutoHideTimerId = window.setTimeout(() => {
    setHidden(globalAlert, true);
    setText(globalAlert, "");
    alertAutoHideTimerId = 0;
  }, autoHideDelay);
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setBootLoading(loading, message, detail) {
  if (bootLoadingTitle && message) {
    bootLoadingTitle.textContent = message;
  }
  if (bootLoadingCopy && detail) {
    bootLoadingCopy.textContent = detail;
  }
  if (bootLoading) {
    bootLoading.hidden = !loading;
  }
  document.body.classList.toggle("is-boot-loading", loading);
  mainContent?.setAttribute("aria-busy", String(loading));
}

function setBootStage(stage, message, detail) {
  bootStage = stage;
  setBootLoading(true, message, detail);
}

function startOperationLoading(message) {
  const startedAt = Date.now();
  operationLoadingCount += 1;

  if (operationLoadingText && message) {
    operationLoadingText.textContent = message;
  }
  if (operationLoading) {
    operationLoading.hidden = false;
  }

  document.body.classList.add("is-operation-loading");
  transcriptList?.setAttribute("aria-busy", "true");

  return async () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_OPERATION_LOADING_MS) {
      await delay(MIN_OPERATION_LOADING_MS - elapsed);
    }

    operationLoadingCount = Math.max(0, operationLoadingCount - 1);
    if (operationLoadingCount > 0) {
      return;
    }

    if (operationLoading) {
      operationLoading.hidden = true;
    }
    transcriptList?.setAttribute("aria-busy", "false");
    document.body.classList.remove("is-operation-loading");
  };
}

async function copyTextToClipboard(text) {
  if (!text) {
    return false;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.append(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }

  return copied;
}

function autoResizeComposer() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight || 800;
  const composerMaxHeight = Math.max(168, Math.min(420, Math.floor(viewportHeight * 0.45)));
  composerInput.style.height = "auto";
  const nextHeight = Math.min(
    Math.max(composerInput.scrollHeight, COMPOSER_MIN_HEIGHT),
    composerMaxHeight,
  );
  composerInput.style.height = `${nextHeight}px`;
  composerInput.style.overflowY = "hidden";
  syncComposerOffset();
}

function syncComposerOffset() {
  const fallback = 88;
  const height = composerShell?.offsetHeight || fallback;
  document.documentElement.style.setProperty("--composer-offset", `${Math.max(fallback, height)}px`);
}

function renderTranscript() {
  const distanceFromBottom =
    transcriptList.scrollHeight - transcriptList.scrollTop - transcriptList.clientHeight;
  transcriptList.innerHTML = "";

  for (const entry of state.transcript) {
    const item = document.createElement("li");
    item.className = `message ${entry.role}`;

    const row = document.createElement("div");
    row.className = "message-row";

    const content = document.createElement("div");
    content.className = "message-content";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = entry.role === "user" ? "你" : "Codex";

    const time = document.createElement("span");
    time.className = "timestamp";
    time.textContent = formatTime(entry.time);

    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMessageHtml(entry.text);

    meta.append(label, time);
    content.append(meta, body);
    row.append(content);
    item.append(row);
    transcriptList.append(item);
  }

  transcriptEmpty.classList.toggle("hidden", state.transcript.length > 0);

  if (shouldStickToBottom) {
    scrollTranscriptToBottom();
    return;
  }

  transcriptList.scrollTop = Math.max(
    0,
    transcriptList.scrollHeight - transcriptList.clientHeight - distanceFromBottom,
  );
  updateJumpToLatestVisibility();
}

function renderSessionCandidates() {
  sessionCandidates.innerHTML = "";

  if (!sessionsLoaded) {
    const item = document.createElement("li");
    item.textContent = sessionsLoadingPromise ? "正在加载会话列表..." : "点击刷新列表后加载可切换会话。";
    sessionCandidates.append(item);
    return;
  }

  const candidates = state.sessions.filter((item) => item.id !== state.pinnedSessionId);

  if (candidates.length === 0) {
    const item = document.createElement("li");
    item.textContent = "当前没有其他可切换会话。";
    sessionCandidates.append(item);
    return;
  }

  const groups = new Map();
  for (const session of candidates) {
    const projectPath = session.projectPath || "unknown";
    if (!groups.has(projectPath)) {
      groups.set(projectPath, []);
    }
    groups.get(projectPath).push(session);
  }

  for (const expandedPath of expandedProjectPaths) {
    if (!groups.has(expandedPath)) {
      expandedProjectPaths.delete(expandedPath);
    }
  }

  for (const [projectPath, sessions] of groups) {
    const groupItem = document.createElement("li");
    groupItem.className = "session-project-group";
    const isExpanded = expandedProjectPaths.has(projectPath);

    const groupToggle = document.createElement("button");
    groupToggle.type = "button";
    groupToggle.className = "session-project-toggle";
    groupToggle.setAttribute("data-project-toggle", "true");
    groupToggle.setAttribute("data-project-path", projectPath);
    groupToggle.setAttribute("aria-expanded", String(isExpanded));

    const toggleHead = document.createElement("span");
    toggleHead.className = "session-project-head";

    const projectName = document.createElement("span");
    projectName.className = "session-project-label";
    projectName.textContent = basename(projectPath);

    const projectMeta = document.createElement("span");
    projectMeta.className = "session-project-path";
    projectMeta.textContent = `${sessions.length} 个会话`;

    toggleHead.append(projectName, projectMeta);

    const toggleSuffix = document.createElement("span");
    toggleSuffix.className = "session-project-toggle-right";

    const toggleCount = document.createElement("span");
    toggleCount.className = "session-project-count";
    toggleCount.textContent = `${sessions.length}`;

    const toggleCaret = document.createElement("span");
    toggleCaret.className = "session-project-caret";
    toggleCaret.setAttribute("aria-hidden", "true");
    toggleCaret.textContent = "›";

    toggleSuffix.append(toggleCount, toggleCaret);
    groupToggle.append(toggleHead, toggleSuffix);

    const sessionList = document.createElement("ul");
    sessionList.className = "session-project-sessions";
    sessionList.hidden = !isExpanded;

    for (const session of sessions) {
      const item = document.createElement("li");

      const header = document.createElement("div");
      header.className = "session-item-header";

      const titleWrap = document.createElement("div");
      titleWrap.className = "session-item-title-wrap";

      const title = document.createElement("p");
      title.className = "session-item-title";
      title.textContent = session.name || session.id;

      const scope = document.createElement("span");
      scope.className = "session-item-tag";
      scope.textContent =
        session.projectPath === state.sessionProjectPath ? "同项目" : "跨项目";

      titleWrap.append(title, scope);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-secondary";
      button.textContent = "切换";
      button.setAttribute("data-session-id", session.id);

      const meta = document.createElement("p");
      meta.className = "session-item-meta";
      meta.textContent = [session.updatedAt ? `updated ${formatTime(session.updatedAt)}` : "", session.id]
        .filter(Boolean)
        .join(" · ");

      header.append(titleWrap, button);
      item.append(header, meta);
      sessionList.append(item);
    }

    groupItem.append(groupToggle, sessionList);
    sessionCandidates.append(groupItem);
  }
}

function jumpToChatView() {
  setDrawer(false);

  window.setTimeout(() => {
    const chatAnchor = document.querySelector(".composer-shell") || transcriptList;
    chatAnchor?.scrollIntoView({ behavior: "smooth", block: "end" });
    scrollTranscriptToBottom();
    try {
      composerInput.focus({ preventScroll: true });
    } catch {
      composerInput.focus();
    }
  }, DRAWER_CLOSE_TRANSITION_MS);
}

function renderAuditTrail() {
  auditList.innerHTML = "";

  if (state.auditTrail.length === 0) {
    const item = document.createElement("li");
    item.textContent = "暂无显式切换或恢复审计记录。";
    auditList.append(item);
    return;
  }

  for (const row of state.auditTrail) {
    const item = document.createElement("li");

    const header = document.createElement("span");
    header.className = "audit-time";
    header.textContent = `${formatTime(row.time)} · ${row.action}`;

    const body = document.createElement("p");
    body.className = "audit-text";
    body.textContent = `${row.prevSessionId || "-"} -> ${row.nextSessionId || "-"} | ${row.detail}`;

    item.append(header, body);
    auditList.append(item);
  }
}

function renderSystemMeta() {
  const meta = state.systemMeta;
  if (!meta) {
    setText(securityMode, "mode: unknown");
    setText(securityAuth, "auth: unknown");
    setText(executionMode, "execution: unknown");
    setText(executionSummary, "policy: unknown");
    return;
  }

  setText(securityMode, meta.externalMode ? `mode: external (${meta.host}:${meta.port})` : "mode: local-only");
  const remoteTrustedLabel = meta.security?.remoteTrusted ? " · remote trusted" : "";
  setText(securityAuth, `auth: ${meta.security?.authMode || "none"}${remoteTrustedLabel}`);
  setText(executionMode, `execution: ${meta.execution?.displayName || meta.execution?.profile || "unknown"}`);
  setText(executionSummary, `policy: ${meta.execution?.summary || "unknown"}`);
}

function renderState() {
  setBadge("connection", state.connection);
  setBadge("attach", state.attach);
  setBadge("stream", state.stream);
  setBadge("send", state.send);

  const connected = labels.connection[state.connection] || labels.connection.error;
  setText(connectionSummary, `${connected.summary} · ${labels.attach[state.attach]?.summary || "状态未知"}`);
  setHidden(mobileStatusPill, false);
  setText(mobileStatusPill, connected.summary);
  if (mobileStatusPill) {
    mobileStatusPill.dataset.state = state.connection;
  }

  const canSend =
    state.connection === "connected" && state.attach === "attached";
  const feedback = deriveExecutionFeedback();
  const shouldPromoteRecoveryStop = feedback.kind === "stalled" || feedback.kind === "quiet";
  const isStopMode = state.send === "sending" || state.send === "stopping";
  const canStop = state.send === "sending" && canSend;
  if (sendButton) {
    sendButton.disabled = isStopMode ? !canStop : !canSend;
    sendButton.dataset.action = isStopMode ? "stop" : "send";
    sendButton.classList.toggle("btn-primary", !isStopMode);
    sendButton.classList.toggle("btn-danger", isStopMode);
    sendButton.classList.toggle("is-stop-mode", isStopMode);
    sendButton.classList.toggle("is-urgent-stop", isStopMode && shouldPromoteRecoveryStop);
  }

  const stopLabel = state.send === "stopping" ? "停止中" : shouldPromoteRecoveryStop ? "停止重试" : "停止";
  setAttr(sendButton, "aria-label", isStopMode ? "停止当前执行" : "发送");
  if (sendButtonLabel) {
    setText(sendButtonLabel, isStopMode ? stopLabel : "发送");
  }
  if (sendButtonIconSend) {
    sendButtonIconSend.hidden = isStopMode;
  }
  if (sendButtonIconStop) {
    sendButtonIconStop.hidden = !isStopMode;
  }

  const executionLabel =
    state.systemMeta?.execution?.displayName || state.systemMeta?.execution?.profile || "权限未知";
  setText(composerContext, `已锁定到 ${state.sessionName || "当前会话"}，不会静默切换。当前执行模式：${executionLabel}。`);
  refreshSnapshotPoller();

  const headerExecution = deriveHeaderExecutionState(feedback);
  setText(sendFeedback, feedback.summary);
  if (sendFeedbackMeta) {
    const detail = String(feedback.detail || "").trim();
    setText(sendFeedbackMeta, detail);
    setHidden(sendFeedbackMeta, detail.length === 0);
  }
  if (executionStatusPill) {
    setText(executionStatusPill, headerExecution.label);
    executionStatusPill.dataset.state = headerExecution.state;
  }
  if (executionSummaryInline) {
    setText(executionSummaryInline, headerExecution.summary);
  }
}

function updateBinding(binding) {
  state.attach = binding.attach;
  state.connection = binding.connection;
  state.executionState = binding.executionState || null;
  state.send = binding.send;
  state.stream = binding.stream;
  state.pinnedSessionId = binding.pinnedSessionId || "";
  state.sessionName = binding.session?.name || "未绑定真实会话";
  state.sessionProjectPath = binding.session?.projectPath || "unknown";

  const projectLabel = basename(state.sessionProjectPath);

  setText(sessionName, state.sessionName);
  setText(drawerSessionName, state.sessionName);
  setText(sessionIdentity, state.pinnedSessionId || "unbound");
  setText(sessionProjectPath, state.sessionProjectPath);
  setText(sessionProjectLabel, projectLabel);
}

function replaceTranscript(entries) {
  state.transcript = entries.slice();
  seenMessageIds.clear();
  for (const entry of entries) {
    seenMessageIds.add(entry.id);
  }
  shouldStickToBottom = true;
  renderTranscript();
}

function reconcileTranscript(entries) {
  const nextEntries = Array.isArray(entries) ? entries : [];

  if (state.transcript.length === 0) {
    replaceTranscript(nextEntries);
    return;
  }

  const overlapLength = Math.min(state.transcript.length, nextEntries.length);
  let prefixMatches = nextEntries.length >= state.transcript.length;

  for (let index = 0; index < overlapLength; index += 1) {
    if (state.transcript[index]?.id !== nextEntries[index]?.id) {
      prefixMatches = false;
      break;
    }
  }

  if (!prefixMatches) {
    replaceTranscript(nextEntries);
    return;
  }

  if (nextEntries.length === state.transcript.length) {
    return;
  }

  for (const entry of nextEntries.slice(state.transcript.length)) {
    appendMessage(entry);
  }
}

function getLatestTranscriptId() {
  return state.transcript.at(-1)?.id || "";
}

function appendMessage(entry) {
  if (seenMessageIds.has(entry.id)) {
    return;
  }

  seenMessageIds.add(entry.id);
  state.transcript.push(entry);
  renderTranscript();
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (payload == null) {
      throw new Error("服务返回了非 JSON 响应，可能是鉴权或穿透链路异常，请刷新页面重试。");
    }
    if (!response.ok || payload.ok === false) {
      const message = payload?.error?.message || "请求失败";
      throw new Error(message);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("请求超时，请重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function parseEventPayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

async function loadSessions() {
  const payload = await requestJson("/api/sessions");
  state.sessions = payload.sessions || [];
  sessionsLoaded = true;
  renderSessionCandidates();
}

async function ensureSessionCatalogLoaded({ force = false, silent = false } = {}) {
  if (sessionsLoadingPromise) {
    return sessionsLoadingPromise;
  }

  if (sessionsLoaded && !force) {
    return;
  }

  sessionsLoadingPromise = (async () => {
    try {
      await loadSessions();
    } catch (error) {
      if (!silent) {
        throw error;
      }
    } finally {
      sessionsLoadingPromise = null;
      renderSessionCandidates();
    }
  })();

  return sessionsLoadingPromise;
}

async function loadAuditTrail() {
  const payload = await requestJson("/api/session/audit?limit=20");
  state.auditTrail = payload.auditTrail || [];
  renderAuditTrail();
}

async function loadSystemMeta() {
  const payload = await requestJson("/api/system/meta");
  markTransportActivity();
  state.systemMeta = payload;
  renderSystemMeta();
}

function getSnapshotPollInterval() {
  if (state.send === "sending" || state.send === "stopping") {
    return SEND_ACTIVE_SNAPSHOT_POLL_MS;
  }

  if (state.systemMeta?.externalMode) {
    return EXTERNAL_IDLE_SNAPSHOT_POLL_MS;
  }

  if (hadStreamError) {
    return STREAM_ERROR_SNAPSHOT_POLL_MS;
  }

  return 0;
}

function refreshTransportWatchdog() {
  if (transportWatchdogTimer) {
    window.clearInterval(transportWatchdogTimer);
    transportWatchdogTimer = null;
  }

  if (!state.systemMeta?.externalMode) {
    return;
  }

  transportWatchdogTimer = window.setInterval(() => {
    if (document.hidden || !lastTransportActivityAt) {
      return;
    }

    const staleMs = Date.now() - lastTransportActivityAt;
    if (staleMs >= EXTERNAL_STALE_RECONNECT_MS) {
      reconnectStream();
      void syncBindingSnapshot({ silent: true });
      return;
    }

    if (staleMs >= EXTERNAL_STALE_SNAPSHOT_MS) {
      void syncBindingSnapshot({ silent: true });
    }
  }, EXTERNAL_WATCHDOG_INTERVAL_MS);
}

function refreshSnapshotPoller() {
  const nextPollMs = getSnapshotPollInterval();
  if (snapshotPollTimer && snapshotPollMs === nextPollMs) {
    return;
  }

  if (snapshotPollTimer) {
    window.clearInterval(snapshotPollTimer);
    snapshotPollTimer = null;
  }

  snapshotPollMs = nextPollMs;
  if (!nextPollMs) {
    return;
  }

  snapshotPollTimer = window.setInterval(() => {
    void syncBindingSnapshot({ silent: true });
  }, nextPollMs);
}

async function syncBindingSnapshot({ silent = false } = {}) {
  if (snapshotPollInFlight) {
    return;
  }

  snapshotPollInFlight = true;
  try {
    const afterId = encodeURIComponent(getLatestTranscriptId());
    const payload = await requestJson(`/api/session/snapshot?after=${afterId}&_ts=${Date.now()}`);
    updateBinding(requireBinding(payload.binding, "快照同步"));
    state.failureModes = payload.failureModes || state.failureModes;
    markTransportActivity();

    const snapshot = payload.snapshot || {};
    const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    if (snapshot.reset) {
      replaceTranscript(entries);
    } else {
      for (const entry of entries) {
        appendMessage(entry);
      }
    }

    renderState();
  } catch (error) {
    if (!silent) {
      setAlert(error.message);
    }
  } finally {
    snapshotPollInFlight = false;
  }
}

function reconnectStream() {
  if (stream) {
    stream.close();
  }

  stream = new EventSource("/api/session/stream");
  state.connection = "connecting";
  renderState();

  stream.addEventListener("state", (event) => {
    const payload = parseEventPayload(event);
    if (!isBindingPayload(payload)) {
      state.connection = "error";
      state.stream = "error";
      renderState();
      setAlert("实时状态包无效，可能是外网链路返回了异常内容，请刷新页面重试。");
      return;
    }

    markTransportActivity();
    updateBinding(payload);
    renderState();
    refreshSnapshotPoller();
    refreshTransportWatchdog();

    if (hadStreamError && state.connection === "connected") {
      hadStreamError = false;
      setAlert("连接已恢复，继续使用同一 pinned session。");
      refreshSnapshotPoller();
    }
  });

  stream.addEventListener("failureModes", (event) => {
    const payload = parseEventPayload(event);
    if (!payload) {
      return;
    }
    markTransportActivity();
    state.failureModes = payload;
  });

  stream.addEventListener("message", (event) => {
    const payload = parseEventPayload(event);
    if (!payload?.entry) {
      return;
    }
    markTransportActivity();
    appendMessage(payload.entry);
  });

  stream.addEventListener("audit", () => {
    markTransportActivity();
    void loadAuditTrail();
  });

  stream.addEventListener("heartbeat", () => {
    markTransportActivity();
  });

  stream.addEventListener("sendFailure", (event) => {
    const payload = parseEventPayload(event);
    markTransportActivity();
    state.send = "error";
    renderState();
    setAlert(payload?.message || "发送失败。");
  });

  stream.addEventListener("stop", (event) => {
    const payload = parseEventPayload(event);
    if (!payload || payload.sessionId !== state.pinnedSessionId) {
      return;
    }
    markTransportActivity();

    if (payload.status === "stopped") {
      setAlert(payload.message || "当前执行已停止。");
      return;
    }

    if (payload.status === "stop-failed") {
      setAlert(payload.message || "停止失败。");
      return;
    }

    if (payload.status === "stopping") {
      setAlert("");
    }
  });

  stream.onerror = () => {
    hadStreamError = true;
    state.connection = "error";
    state.stream = "error";
    renderState();
    refreshSnapshotPoller();
    setAlert("流连接中断，正在自动重连。");
  };
}

async function loadInitialState() {
  const payload = await requestJson("/api/session/binding");
  markTransportActivity();
  updateBinding(requireBinding(payload.binding, "初始化"));
  state.failureModes = payload.failureModes || state.failureModes;
  state.auditTrail = payload.auditTrail || [];
  replaceTranscript(payload.transcript || []);
  renderAuditTrail();
  renderState();
}

async function setFailure(kind, enabled) {
  const payload = await requestJson("/api/testing/failure", {
    body: JSON.stringify({ enabled, kind }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  state.failureModes = payload.failureModes;
}

async function resetFailureModes() {
  const payload = await requestJson("/api/testing/reset", {
    method: "POST",
  });
  state.failureModes = payload.failureModes;
}

openDrawerButton?.addEventListener("click", () => {
  setDrawer(true);
  void ensureSessionCatalogLoaded({ silent: true });
});
closeDrawerButton?.addEventListener("click", () => setDrawer(false));
closeDrawerButtonMobile?.addEventListener("click", () => setDrawer(false));
drawerBackdrop?.addEventListener("click", () => setDrawer(false));
drawerOpeners.forEach((button) =>
  button.addEventListener("click", () => {
    setDrawer(true);
    void ensureSessionCatalogLoaded({ silent: true });
  }),
);
jumpToLatestButton?.addEventListener("click", () => scrollTranscriptToBottom());

transcriptList?.addEventListener("scroll", () => {
  shouldStickToBottom = isNearBottom();
  updateJumpToLatestVisibility();
});

transcriptList?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const copyButton = target.closest(".code-copy-button");
  if (!(copyButton instanceof HTMLButtonElement)) {
    return;
  }

  const codeElement = copyButton.closest(".code-block")?.querySelector("pre code");
  if (!(codeElement instanceof HTMLElement)) {
    return;
  }

  const copied = await copyTextToClipboard(codeElement.innerText || codeElement.textContent || "");
  if (!copied) {
    setAlert("复制失败，请手动选择代码后复制。");
    return;
  }

  setAlert("");
  copyButton.dataset.copyState = "done";
  copyButton.textContent = "已复制";
  const previousResetTimer = Number(copyButton.dataset.resetTimer || "0");
  if (previousResetTimer) {
    window.clearTimeout(previousResetTimer);
  }

  const nextResetTimer = window.setTimeout(() => {
    copyButton.dataset.copyState = "idle";
    copyButton.textContent = "复制";
    delete copyButton.dataset.resetTimer;
  }, 1300);
  copyButton.dataset.resetTimer = String(nextResetTimer);
});

composerInput?.addEventListener("input", autoResizeComposer);
window.addEventListener("resize", autoResizeComposer);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", autoResizeComposer);
}

window.addEventListener("focus", () => {
  void syncBindingSnapshot({ silent: true });
});

window.addEventListener("pageshow", () => {
  void syncBindingSnapshot({ silent: true });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void syncBindingSnapshot({ silent: true });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setDrawer(false);
  }
});

simulateDisconnect?.addEventListener("click", async () => {
  try {
    await setFailure("connection", true);
    setAlert("连接失败已注入。发送会被阻止，恢复后仍会回到同一会话。");
  } catch (error) {
    setAlert(error.message);
  }
});

simulateReconnect?.addEventListener("click", async () => {
  const stopOperationLoading = startOperationLoading("正在恢复实时连接...");
  try {
    await resetFailureModes();
    setAlert("");
    reconnectStream();
  } catch (error) {
    setAlert(error.message);
  } finally {
    await stopOperationLoading();
  }
});

explicitSwitch?.addEventListener("click", async () => {
  const stopOperationLoading = startOperationLoading("正在刷新会话列表...");
  explicitSwitch.classList.add("is-loading");
  try {
    sessionsLoaded = false;
    renderSessionCandidates();
    await ensureSessionCatalogLoaded({ force: true });
    setAlert("");
  } catch (error) {
    setAlert(error.message);
  } finally {
    explicitSwitch.classList.remove("is-loading");
    await stopOperationLoading();
  }
});

sessionCandidates?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const projectToggle = target.closest("button[data-project-toggle]");
  if (projectToggle instanceof HTMLButtonElement) {
    const projectPath = projectToggle.dataset.projectPath || "unknown";
    if (expandedProjectPaths.has(projectPath)) {
      expandedProjectPaths.delete(projectPath);
    } else {
      expandedProjectPaths.add(projectPath);
    }
    renderSessionCandidates();
    return;
  }

  const switchButton = target.closest("button[data-session-id]");
  if (!(switchButton instanceof HTMLButtonElement)) {
    return;
  }

  const sessionId = switchButton.getAttribute("data-session-id");
  if (!sessionId) {
    return;
  }

  const sessionLabel =
    switchButton.closest("li")?.querySelector(".session-item-title")?.textContent?.trim() ||
    "目标会话";
  const stopOperationLoading = startOperationLoading(`正在切换到 ${sessionLabel}...`);
  const originalButtonText = switchButton.textContent;
  switchButton.classList.add("is-loading");
  switchButton.textContent = "切换中";
  try {
    const attachPayload = await requestJson("/api/session/attach", {
      body: JSON.stringify({ explicit: true, sessionId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    updateBinding(requireBinding(attachPayload.binding, "切换会话"));
    replaceTranscript(attachPayload.transcript || []);
    await loadSessions();
    await loadAuditTrail();
    renderState();
    setAlert("");
    jumpToChatView();
  } catch (error) {
    setAlert(error.message);
  } finally {
    if (switchButton.isConnected) {
      switchButton.classList.remove("is-loading");
      switchButton.textContent = originalButtonText;
    }
    await stopOperationLoading();
  }
});

failureButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const failureType = button.getAttribute("data-failure");
    if (!failureType) {
      return;
    }

    const mapping = {
      connection: "connection",
      send: "send",
      session: "attach",
    };
    const kind = mapping[failureType];
    if (!kind) {
      return;
    }

    try {
      await setFailure(kind, true);
      setAlert(`已触发 ${kind} 失败模式。`);
    } catch (error) {
      setAlert(error.message);
    }
  });
});

async function sendCurrentMessage() {
  if (state.send === "sending" || state.send === "stopping") {
    return;
  }

  const value = composerInput.value.trim();

  if (value.length < 2) {
    setAlert("请输入至少 2 个字符后再发送。");
    composerInput.focus();
    return;
  }

  state.send = "sending";
  state.executionState = {
    acceptedAt: null,
    exitCode: null,
    lastActivityAt: new Date().toISOString(),
    lastVisibleMessageAt: null,
    phase: "starting",
    processAlive: false,
    startedAt: new Date().toISOString(),
    statusDetail: "指令已发送，正在等待本地 bridge 确认。",
    updatedAt: new Date().toISOString(),
  };
  renderState();
  setAlert("");

  try {
    await requestJson("/api/session/send", {
      body: JSON.stringify({ message: value }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await syncBindingSnapshot({ silent: true });
    composerInput.value = "";
    autoResizeComposer();
  } catch (error) {
    state.send = "error";
    renderState();
    setAlert(error.message);
  }
}

async function stopCurrentExecution() {
  if (state.send === "stopping") {
    return;
  }

  state.send = "stopping";
  if (state.executionState) {
    state.executionState = {
      ...state.executionState,
      lastActivityAt: new Date().toISOString(),
      phase: "stopping",
      statusDetail: "停止请求已发出，等待执行进程退出。",
      updatedAt: new Date().toISOString(),
    };
  }
  renderState();
  setAlert("");

  try {
    const payload = await requestJson("/api/session/stop", {
      method: "POST",
    });
    if (payload.binding) {
      updateBinding(requireBinding(payload.binding, "停止执行"));
    }
    renderState();

    if (payload.result?.status === "idle") {
      setAlert(payload.result.message || "当前没有正在执行的对话。");
      return;
    }

    if (payload.result?.status === "stop-failed") {
      setAlert(payload.result.message || "停止失败。");
      return;
    }

    setAlert("");
  } catch (error) {
    state.send = "error";
    renderState();
    setAlert(error.message);
  }
}

composerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendCurrentMessage();
});

sendButton?.addEventListener("click", async () => {
  if (sendButton.dataset.action === "stop") {
    await stopCurrentExecution();
    return;
  }
  await sendCurrentMessage();
});

async function bootstrap() {
  setBootStage("恢复会话", "正在恢复会话", "读取本地会话绑定与历史消息...");
  const bootGuardId = window.setTimeout(() => {
    if (bootLoading?.hidden) {
      return;
    }
    setBootLoading(false);
    setAlert(`启动超时（${bootStage}），请点击详情并刷新列表重试。`);
  }, BOOT_LOADING_MAX_MS);

  try {
    if (!ensureRequiredDom()) {
      return;
    }
    setBootStage("恢复会话", "正在恢复会话", "读取本地会话绑定与历史消息...");
    await loadInitialState();

    setBootStage("校验执行边界", "正在校验执行边界", "检查执行模式与安全边界...");
    await loadSystemMeta();

    setBootStage("建立实时通道", "正在建立实时通道", "连接实时流并准备接收回复...");
    autoResizeComposer();
    syncComposerOffset();
    reconnectStream();
    void ensureSessionCatalogLoaded({ silent: true });
  } catch (error) {
    state.connection = "error";
    state.stream = "error";
    renderState();
    setAlert(error.message);
  } finally {
    window.clearTimeout(bootGuardId);
    setBootLoading(false);
  }
}

bootstrap();
