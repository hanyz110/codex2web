import { spawnSync } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError, LocalSessionBridge } from "./local-bridge.js";
import { ClaudeReadonlyBridge } from "./providers/claude-readonly-bridge.js";

const port = Number(process.env.PORT || "4321");
const host = process.env.HOST || "127.0.0.1";
const externalMode = process.env.CODEX2WEB_EXTERNAL === "true";
const externalTrustedMode =
  process.env.CODEX2WEB_REMOTE_TRUSTED === "true" || process.env.CODEX2WEB_EXTERNAL_TRUSTED === "true";
const basicAuthUser = process.env.CODEX2WEB_BASIC_USER || "";
const basicAuthPass = process.env.CODEX2WEB_BASIC_PASS || "";
const requestedProvider = String(process.env.CODEX2WEB_PROVIDER || "codex").trim().toLowerCase();
const requestedExecutionProfile = String(process.env.CODEX2WEB_EXECUTION_PROFILE || "").trim();
const codexBinaryPath = process.env.CODEX2WEB_CODEX_BINARY || undefined;
const claudeBinaryPath = process.env.CODEX2WEB_CLAUDE_BINARY || process.env.CLAUDE2WEB_CLAUDE_BINARY || undefined;
const claudeProjectsRoot = process.env.CLAUDE2WEB_PROJECTS_ROOT || process.env.CODEX2WEB_CLAUDE_PROJECTS_ROOT || undefined;
const claudeSendRequested = process.env.CLAUDE2WEB_ENABLE_SEND === "true";
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const auditFilePath = path.join(projectRoot, ".codex2web", "session-audit.jsonl");
const claudeAuditFilePath = path.join(projectRoot, ".codex2web", "claude-session-audit.jsonl");
const claudeStateFilePath = path.join(projectRoot, ".codex2web", "claude-session-pin.json");
const clientSessionPinsFilePath = path.join(projectRoot, ".codex2web", "client-session-pins.json");
const stateFilePath = path.join(projectRoot, ".codex2web", "session-pin.json");
const uploadDir = path.join(projectRoot, ".codex2web", "uploads");
const claudeImageOcrScriptPath = path.join(projectRoot, "scripts", "claude-image-ocr.swift");
const defaultCodexBinaryPath = path.join(os.homedir(), ".bun", "bin", "codex");
const authEnabled = basicAuthUser.length > 0 && basicAuthPass.length > 0;
const cookieAuthSecret = process.env.CODEX2WEB_COOKIE_AUTH_SECRET || basicAuthPass;
const cookieAuthName = "claude2web_auth";
const fallbackCookieAuthName = "claude2web_auth_fallback";
const isHostLocalOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const requiresExternalAuthBoundary = externalMode || !isHostLocalOnly;

if (requestedProvider !== "codex" && requestedProvider !== "claude") {
  process.stderr.write("Unknown CODEX2WEB_PROVIDER. Expected codex or claude.\n");
  process.exit(1);
}

if (requiresExternalAuthBoundary && !authEnabled) {
  process.stderr.write(
    [
      "Refusing to start in external mode without auth boundary.",
      "Set CODEX2WEB_BASIC_USER and CODEX2WEB_BASIC_PASS before exposing the server.",
    ].join(" "),
    );
  process.stderr.write("\n");
  process.exit(1);
}

function buildExecutionPolicy({ externalTrustedMode, requestedProfile, requiresExternalAuthBoundary }) {
  const normalizedProfile = String(requestedProfile || "").trim().toLowerCase();
  const defaultProfile = requiresExternalAuthBoundary ? (externalTrustedMode ? "dangerous" : "full-auto") : "dangerous";
  const profile = normalizedProfile || defaultProfile;
  const source = normalizedProfile ? "env" : "mode-default";

  const catalog = {
    dangerous: {
      cliArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      displayName: requiresExternalAuthBoundary ? "远程完全权限" : "本地完全权限",
      profile: "dangerous",
      summary: requiresExternalAuthBoundary
        ? "浏览器发送使用无审批、无沙箱模式。该模式仅在你显式开启 remote trusted external 后可用于外网访问。"
        : "浏览器发送使用无审批、无沙箱模式，仅允许在本地 trusted 场景下启用。",
      trustBoundary: requiresExternalAuthBoundary ? "external-trusted" : "local-trusted",
    },
    "full-auto": {
      cliArgs: ["--full-auto"],
      displayName: "沙箱自动执行",
      profile: "full-auto",
      summary: "浏览器发送使用 Codex 的 full-auto 模式，在 workspace-write 沙箱内自动执行。",
      trustBoundary: requiresExternalAuthBoundary ? "external-guarded" : "local-guarded",
    },
    restricted: {
      cliArgs: [],
      displayName: "受限默认执行",
      profile: "restricted",
      summary: "浏览器发送不附加额外执行权限，保留 Codex CLI 的默认审批与沙箱行为。",
      trustBoundary: requiresExternalAuthBoundary ? "external-restricted" : "local-restricted",
    },
  };

  if (!(profile in catalog)) {
    throw new Error(
      `Unknown CODEX2WEB_EXECUTION_PROFILE: ${profile}. Expected one of restricted, full-auto, dangerous.`,
    );
  }

  if (requiresExternalAuthBoundary && profile === "dangerous" && !externalTrustedMode) {
    throw new Error(
      "Refusing to start with execution profile=dangerous while external auth boundary is enabled. Set CODEX2WEB_REMOTE_TRUSTED=true if you intentionally want remote trusted execution.",
    );
  }

  return {
    ...catalog[profile],
    source,
  };
}

let executionPolicy;
try {
  executionPolicy = buildExecutionPolicy({
    externalTrustedMode,
    requestedProfile: requestedExecutionProfile,
    requiresExternalAuthBoundary,
  });
} catch (error) {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
}

const bridge =
  requestedProvider === "claude"
    ? new ClaudeReadonlyBridge({
        auditFilePath: claudeAuditFilePath,
        claudeBinaryPath,
        sendRequested: claudeSendRequested,
        sessionRootPath: claudeProjectsRoot,
        stateFilePath: claudeStateFilePath,
      })
    : new LocalSessionBridge({
        auditFilePath,
        codexBinaryPath,
        executionPolicy,
        projectPath: projectRoot,
        stateFilePath,
      });
await bridge.init();
const clientSessionPins = await readClientSessionPins();

const contentTypeByExt = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const MAX_BODY_BYTES = 64 * 1024;
const BINDING_TRANSCRIPT_LIMIT = 20;
const BINDING_TRANSCRIPT_BYTES_BUDGET = 16 * 1024;
const STREAM_REPLAY_TRANSCRIPT_LIMIT = 20;
const HISTORY_TRANSCRIPT_PAGE_LIMIT = 80;
const MAX_SEND_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/gif", { ext: ".gif", magic: (buffer) => buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a" }],
  ["image/jpeg", { ext: ".jpg", magic: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ["image/png", { ext: ".png", magic: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ["image/webp", { ext: ".webp", magic: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" }],
]);
const NO_STORE_HEADERS = {
  "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
  expires: "0",
  pragma: "no-cache",
  vary: "Authorization",
};

function resolveRequestedFile(urlPathname) {
  const normalizedPath = path.posix.normalize(urlPathname);
  const targetPath = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const safeRelativePath = `.${targetPath}`;
  const filePath = path.resolve(publicDir, safeRelativePath);

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  return filePath;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...NO_STORE_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function normalizeClientId(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(trimmed) ? trimmed : "";
}

async function readClientSessionPins() {
  try {
    const parsed = JSON.parse(await readFile(clientSessionPinsFilePath, "utf-8"));
    const pins = parsed?.clients && typeof parsed.clients === "object" ? parsed.clients : {};
    return new Map(
      Object.entries(pins)
        .map(([clientId, sessionId]) => [normalizeClientId(clientId), typeof sessionId === "string" ? sessionId : ""])
        .filter(([clientId, sessionId]) => clientId && sessionId),
    );
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      process.stderr.write(`Failed to load client session pins: ${String(error)}\n`);
    }
    return new Map();
  }
}

async function persistClientSessionPins() {
  try {
    await mkdir(path.dirname(clientSessionPinsFilePath), { recursive: true });
    await writeFile(
      clientSessionPinsFilePath,
      JSON.stringify(
        {
          clients: Object.fromEntries(clientSessionPins.entries()),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (error) {
    process.stderr.write(`Failed to persist client session pins: ${String(error)}\n`);
  }
}

function getRequestClientId(req, parsedUrl) {
  return normalizeClientId(req.headers["x-codex2web-client-id"]) ||
    normalizeClientId(parsedUrl.searchParams.get("clientId") || "");
}

function getClientPinnedSessionId(clientId) {
  return clientId && clientSessionPins.has(clientId)
    ? clientSessionPins.get(clientId)
    : bridge.getBinding().pinnedSessionId;
}

function getClientBinding(clientId) {
  return bridge.getBinding(getClientPinnedSessionId(clientId));
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  });
  return result.status === 0;
}

function getRuntimeReadiness() {
  const bunBinDir = path.join(os.homedir(), ".bun", "bin");
  const pathEntries = String(process.env.PATH || "")
    .split(":")
    .filter(Boolean);
  const effectiveCodexBinaryPath = codexBinaryPath || defaultCodexBinaryPath;

  return {
    bunAvailable: commandAvailable("bun"),
    codexBinaryExists: existsSync(effectiveCodexBinaryPath),
    pathHasBunBin: pathEntries.includes(bunBinDir),
  };
}

function decodeBasicAuthHeader(authHeaderValue) {
  if (!authHeaderValue || !authHeaderValue.startsWith("Basic ")) {
    return null;
  }

  const encoded = authHeaderValue.slice("Basic ".length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const splitIndex = decoded.indexOf(":");
    if (splitIndex < 0) {
      return null;
    }
    const user = decoded.slice(0, splitIndex);
    const pass = decoded.slice(splitIndex + 1);
    return { pass, user };
  } catch {
    return null;
  }
}

function isValidCredentialPair(user, pass) {
  return user === basicAuthUser && pass === basicAuthPass;
}

function signCookieAuth(user) {
  const payload = Buffer.from(JSON.stringify({ t: Date.now(), u: user }), "utf-8").toString("base64url");
  const signature = createHmac("sha256", cookieAuthSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyCookieAuth(value) {
  if (!value || !cookieAuthSecret) {
    return false;
  }

  const [payload, signature] = String(value).split(".");
  if (!payload || !signature) {
    return false;
  }

  const expected = createHmac("sha256", cookieAuthSecret).update(payload).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return decoded?.u === basicAuthUser;
  } catch {
    return false;
  }
}

function getCookieValue(req, name) {
  const cookieHeader = String(req.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return "";
}

function requestUsesHttps(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .find(Boolean);
  return forwardedProto === "https" || Boolean(req.socket?.encrypted);
}

function buildAuthCookieHeader(token, maxAgeSeconds = 60 * 60 * 24 * 7, options = {}) {
  const name = options.name || cookieAuthName;
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure === true) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearAuthCookieHeader(req) {
  const secure = requestUsesHttps(req);
  return [
    buildAuthCookieHeader("", 0, { secure }),
    buildAuthCookieHeader("", 0, { httpOnly: false, name: fallbackCookieAuthName, secure }),
  ];
}

function isAuthorized(req) {
  if (!authEnabled) {
    return true;
  }

  const credentials = decodeBasicAuthHeader(req.headers.authorization);
  if (credentials && isValidCredentialPair(credentials.user, credentials.pass)) {
    return true;
  }

  return (
    verifyCookieAuth(getCookieValue(req, cookieAuthName)) ||
    verifyCookieAuth(getCookieValue(req, fallbackCookieAuthName))
  );
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, {
    ...NO_STORE_HEADERS,
    location,
    ...extraHeaders,
  });
  res.end();
}

function sendLoginPage(res, options = {}) {
  const errorMessage = options.error ? "用户名或密码错误，请重试。" : "";
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Claude2Web 登录</title>",
    "<style>",
    ':root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #18202a; }",
    "main { width: min(360px, calc(100vw - 40px)); padding: 24px; background: white; border: 1px solid #dce1e8; border-radius: 10px; box-shadow: 0 18px 48px rgba(20, 31, 45, 0.14); }",
    "h1 { margin: 0 0 8px; font-size: 22px; }",
    "p { margin: 0 0 18px; color: #53606f; line-height: 1.5; }",
    "label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 650; }",
    "input { box-sizing: border-box; width: 100%; height: 42px; border: 1px solid #c9d1dc; border-radius: 8px; padding: 0 12px; font-size: 16px; }",
    "button { width: 100%; height: 42px; margin-top: 18px; border: 0; border-radius: 8px; background: #165dff; color: white; font-size: 16px; font-weight: 700; }",
    ".error { min-height: 20px; margin-top: 12px; color: #b42318; font-size: 13px; }",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Claude2Web</h1>",
    "<p>请输入外网访问用户名和密码。</p>",
    '<form method="post" action="/auth/login">',
    '<label for="username">用户名</label>',
    '<input id="username" name="username" autocomplete="username" required />',
    '<label for="password">密码</label>',
    '<input id="password" name="password" type="password" autocomplete="current-password" required />',
    '<button type="submit">登录</button>',
    `<div class="error">${errorMessage}</div>`,
    "</form>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");

  res.writeHead(200, {
    ...NO_STORE_HEADERS,
    "content-type": "text/html; charset=utf-8",
  });
  if (options.headOnly) {
    res.end();
    return;
  }
  res.end(html);
}

function sendLoginSuccessPage(res, extraHeaders = {}, options = {}) {
  const fallbackCookieScript = options.cookieToken
    ? [
        "(function () {",
        `  const fallbackCookie = ${JSON.stringify(
          `${fallbackCookieAuthName}=${encodeURIComponent(options.cookieToken)}; Path=/; SameSite=Lax; Max-Age=604800${
            options.secure ? "; Secure" : ""
          }`,
        )};`,
        "  try { document.cookie = fallbackCookie; } catch (error) {}",
        "})();",
      ]
    : [];
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>登录成功</title>",
    "<style>",
    ':root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #18202a; }",
    "main { width: min(360px, calc(100vw - 40px)); padding: 24px; background: white; border: 1px solid #dce1e8; border-radius: 10px; box-shadow: 0 18px 48px rgba(20, 31, 45, 0.14); text-align: center; }",
    "h1 { margin: 0 0 8px; font-size: 22px; }",
    "p { margin: 0; color: #53606f; line-height: 1.5; }",
    ".actions { margin-top: 18px; display: grid; gap: 10px; }",
    ".button { display: inline-flex; justify-content: center; align-items: center; width: 100%; height: 42px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 700; }",
    ".button-primary { background: #165dff; color: white; }",
    ".button-secondary { border: 1px solid #c9d1dc; color: #18202a; background: white; }",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>登录成功</h1>",
    '<p id="loginStatus">正在确认登录状态...</p>',
    '<div class="actions">',
    '<a class="button button-primary" href="/" id="continueLink">继续进入</a>',
    '<a class="button button-secondary" href="/auth/login">返回登录页</a>',
    "</div>",
    "<script>",
    ...fallbackCookieScript,
    "(function () {",
    "  const status = document.getElementById('loginStatus');",
    "  const continueLink = document.getElementById('continueLink');",
    "  let redirected = false;",
    "  function setStatus(text) { if (status) status.textContent = text; }",
    "  function enterApp() {",
    "    if (redirected) return;",
    "    redirected = true;",
    "    setStatus('登录状态已确认，正在进入 Claude2Web...');",
    "    window.location.replace('/');",
    "  }",
    "  async function probeAuth() {",
    "    try {",
    "      const response = await fetch('/auth/check', { cache: 'no-store', credentials: 'include' });",
    "      const payload = await response.json().catch(() => null);",
    "      if (response.ok && payload && payload.authorized === true) {",
    "        enterApp();",
    "        return true;",
    "      }",
    "    } catch (error) {",
    "    }",
    "    return false;",
    "  }",
    "  async function waitForCookie() {",
    "    for (let attempt = 0; attempt < 20; attempt += 1) {",
    "      const ok = await probeAuth();",
    "      if (ok) return;",
    "      await new Promise((resolve) => window.setTimeout(resolve, 250));",
    "    }",
    "    setStatus('登录已提交，但浏览器尚未确认会话。可点“继续进入”重试。');",
    "  }",
    "  continueLink?.addEventListener('click', function () { setStatus('正在进入 Claude2Web...'); });",
    "  waitForCookie();",
    "})();",
    "</script>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");

  res.writeHead(200, {
    ...NO_STORE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    ...extraHeaders,
  });
  res.end(html);
}

function sendAuthCheck(res, req) {
  sendJson(res, 200, {
    authorized: isAuthorized(req),
    ok: true,
  });
}

function requestAuth(res, req) {
  const isHtmlRequest = (req.method === "GET" || req.method === "HEAD") && !(req.url || "").startsWith("/api/");
  if (isHtmlRequest) {
    redirect(res, "/auth/login");
    return;
  }

  sendJson(res, 401, {
    error: {
      code: "AUTH_REQUIRED",
      message: "登录状态已失效，请刷新页面重新登录后再试。",
    },
    ok: false,
  });
}
function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new BridgeError(413, "Request body too large.", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BridgeError(400, "Invalid JSON body.", "INVALID_JSON");
  }
}

function decodeBase64ImageData(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(400, "Image data is required.", "INVALID_IMAGE_DATA");
  }

  const commaIndex = value.indexOf(",");
  const base64 = value.startsWith("data:") && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new BridgeError(400, "Image data must be valid base64.", "INVALID_IMAGE_DATA");
  }

  return Buffer.from(base64, "base64");
}


function runImageOcr(imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0 || !existsSync(claudeImageOcrScriptPath)) {
    return [];
  }

  const result = spawnSync(claudeImageOcrScriptPath, imagePaths, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 30000,
  });

  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || "unknown OCR failure")
      .replace(/\s+/g, " ")
      .slice(0, 300);
    return imagePaths.map((filePath) => ({
      error: detail,
      lineCount: 0,
      path: filePath,
      text: "",
    }));
  }

  try {
    const parsed = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item, index) => ({
      lineCount: Number.isFinite(Number(item?.lineCount)) ? Number(item.lineCount) : 0,
      path: typeof item?.path === "string" && item.path ? item.path : imagePaths[index] || "",
      text: typeof item?.text === "string" ? item.text.slice(0, 12000) : "",
    }));
  } catch (error) {
    const detail = String(error?.message || error || "invalid OCR output").slice(0, 300);
    return imagePaths.map((filePath) => ({
      error: detail,
      lineCount: 0,
      path: filePath,
      text: "",
    }));
  }
}

async function persistImageAttachments(images) {
  if (images == null) {
    return [];
  }

  if (!Array.isArray(images)) {
    throw new BridgeError(400, "Images must be an array.", "INVALID_IMAGES");
  }

  if (images.length > MAX_IMAGE_ATTACHMENTS) {
    throw new BridgeError(400, `最多一次发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`, "TOO_MANY_IMAGES");
  }

  if (images.length === 0) {
    return [];
  }

  await mkdir(uploadDir, { recursive: true });
  const savedPaths = [];
  let totalBytes = 0;

  for (const image of images) {
    const type = typeof image?.type === "string" ? image.type.toLowerCase() : "";
    const config = IMAGE_TYPES.get(type);
    if (!config) {
      throw new BridgeError(400, "仅支持 PNG、JPEG、WebP、GIF 图片。", "UNSUPPORTED_IMAGE_TYPE");
    }

    const buffer = decodeBase64ImageData(image.data);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      throw new BridgeError(400, "单张图片必须大于 0 且不超过 5MB。", "IMAGE_TOO_LARGE");
    }

    totalBytes += buffer.length;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new BridgeError(400, "图片总大小不能超过 12MB。", "IMAGES_TOO_LARGE");
    }

    if (!config.magic(buffer)) {
      throw new BridgeError(400, "图片内容与声明类型不一致。", "INVALID_IMAGE_CONTENT");
    }

    const filePath = path.join(uploadDir, `${Date.now()}-${randomUUID()}${config.ext}`);
    await writeFile(filePath, buffer, { mode: 0o600 });
    savedPaths.push(filePath);
  }

  return savedPaths;
}

function toErrorPayload(error) {
  if (error instanceof BridgeError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
      ok: false,
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal Server Error",
    },
    ok: false,
  };
}

function writeBridgeState(res, clientId) {
  sendSseEvent(res, "state", getClientBinding(clientId));
  sendSseEvent(res, "failureModes", bridge.getFailureModes());
}

function trimTranscriptForBinding(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const limited = entries.slice(-BINDING_TRANSCRIPT_LIMIT);
  const selected = [];
  let totalBytes = 0;

  for (let index = limited.length - 1; index >= 0; index -= 1) {
    const entry = limited[index];
    const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf-8");
    if (selected.length > 0 && totalBytes + nextBytes > BINDING_TRANSCRIPT_BYTES_BUDGET) {
      break;
    }
    selected.push(entry);
    totalBytes += nextBytes;
  }

  return selected.reverse();
}

function trimTranscriptTail(entries, limit = STREAM_REPLAY_TRANSCRIPT_LIMIT) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  return entries.slice(-Math.max(1, limit));
}

async function handleApi(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;
  const method = req.method || "GET";
  const clientId = getRequestClientId(req, parsedUrl);
  const clientSessionId = getClientPinnedSessionId(clientId);

  try {
    if (method === "GET" && pathname === "/api/sessions") {
      const sessions = await bridge.discoverSessions();
      sendJson(res, 200, {
        ok: true,
        pinnedSessionId: clientSessionId,
        sessions,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/binding") {
      await bridge.discoverSessions();
      const binding = bridge.getBinding(clientSessionId);
      const transcript = await bridge.getTranscript(binding.pinnedSessionId);
      sendJson(res, 200, {
        auditTrail: bridge.getAuditTrail(20),
        binding,
        failureModes: bridge.getFailureModes(),
        ok: true,
        transcript: trimTranscriptForBinding(transcript),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/snapshot") {
      await bridge.discoverSessions();
      const afterId = String(parsedUrl.searchParams.get("after") || "");
      const forceFull = String(parsedUrl.searchParams.get("force") || "").toLowerCase() === "full";
      const snapshot = await bridge.getTranscriptSnapshot({ afterId, forceFull, sessionId: clientSessionId });
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        failureModes: bridge.getFailureModes(),
        ok: true,
        snapshot: snapshot.reset
          ? {
              ...snapshot,
              entries: trimTranscriptTail(snapshot.entries),
            }
          : snapshot,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/history") {
      if (typeof bridge.getTranscriptHistoryPage !== "function") {
        throw new BridgeError(501, "Current provider does not support transcript history paging.", "HISTORY_UNSUPPORTED");
      }
      await bridge.discoverSessions();
      const beforeId = String(parsedUrl.searchParams.get("before") || "");
      const requestedLimit = Number(parsedUrl.searchParams.get("limit") || HISTORY_TRANSCRIPT_PAGE_LIMIT);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
        : HISTORY_TRANSCRIPT_PAGE_LIMIT;
      const history = await bridge.getTranscriptHistoryPage({
        beforeId,
        limit,
        sessionId: clientSessionId,
      });
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        history,
        ok: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/audit") {
      const limitParam = parsedUrl.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 30;
      sendJson(res, 200, {
        auditTrail: bridge.getAuditTrail(limit),
        ok: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/system/meta") {
      sendJson(res, 200, {
        execution: bridge.getExecutionPolicy(clientSessionId),
        executionRuntime: bridge.getExecutionRuntimeConfig?.() || null,
        externalMode: requiresExternalAuthBoundary,
        host,
        ok: true,
        port,
        provider: bridge.getProviderInfo(clientSessionId),
        runtime: getRuntimeReadiness(),
        security: {
          authEnabled,
          authMode: authEnabled ? "basic" : "none",
          remoteTrusted: requiresExternalAuthBoundary ? externalTrustedMode : false,
        },
      });
      return;
    }

    if (method === "POST" && pathname === "/api/provider/model") {
      if (typeof bridge.setModelSelection !== "function") {
        throw new BridgeError(501, "Current provider does not support model switching.", "MODEL_SWITCH_UNSUPPORTED");
      }
      const body = await readJsonBody(req);
      const result = await bridge.setModelSelection({
        model: body.model,
        provider: body.provider,
        sessionId: clientSessionId,
      });
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        ok: true,
        ...result,
      });
      return;
    }

    if (method === "POST" && pathname === "/api/session/attach") {
      const body = await readJsonBody(req);
      const binding = await bridge.attachSession(body.sessionId, body.explicit, { persist: !clientId });
      if (clientId) {
        clientSessionPins.set(clientId, binding.pinnedSessionId);
        await persistClientSessionPins();
      }
      sendJson(res, 200, {
        binding: clientId ? bridge.getBinding(binding.pinnedSessionId) : binding,
        ok: true,
      });
      return;
    }

    if (method === "POST" && pathname === "/api/session/send") {
      const body = await readJsonBody(req, MAX_SEND_BODY_BYTES);
      const imagePaths = await persistImageAttachments(body.images);
      const currentProvider = bridge.getProviderInfo?.(clientSessionId)?.model?.current?.provider || "";
      const imageAnalyses = currentProvider === "deepseek" ? runImageOcr(imagePaths) : [];
      const result = await bridge.sendInput(body.message, { imageAnalyses, imagePaths, sessionId: clientSessionId });
      sendJson(res, 200, { ok: true, result });
      return;
    }

    if (method === "POST" && pathname === "/api/session/stop") {
      const result = await bridge.stopInput({ sessionId: clientSessionId });
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        ok: true,
        result,
      });
      return;
    }

    if (method === "POST" && pathname === "/api/testing/failure") {
      const body = await readJsonBody(req);
      bridge.setFailureMode(body.kind, body.enabled);
      sendJson(res, 200, {
        failureModes: bridge.getFailureModes(),
        ok: true,
      });
      return;
    }

    if (method === "POST" && pathname === "/api/testing/reset") {
      bridge.resetFailureModes();
      sendJson(res, 200, {
        failureModes: bridge.getFailureModes(),
        ok: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/stream") {
      await bridge.discoverSessions();
      res.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      writeBridgeState(res, clientId);

      const binding = getClientBinding(clientId);
      const afterId = String(parsedUrl.searchParams.get("after") || "");
      const snapshot = await bridge.getTranscriptSnapshot({ afterId, sessionId: binding.pinnedSessionId });
      const replayEntries = afterId
        ? snapshot.reset
          ? trimTranscriptTail(snapshot.entries)
          : snapshot.entries
        : trimTranscriptTail(snapshot.entries);
      for (const entry of replayEntries) {
        sendSseEvent(res, "message", { entry, replay: true, sessionId: binding.pinnedSessionId });
      }

      const unsubscribe = bridge.subscribe((event) => {
        const currentBinding = getClientBinding(clientId);
        const currentPinned = currentBinding.pinnedSessionId;
        if (event.type === "state") {
          sendSseEvent(res, "state", currentBinding);
          return;
        }
        if (event.type === "message") {
          if (event.payload.sessionId !== currentPinned) {
            return;
          }
        }
        if (event.type === "stop" || event.type === "sendFailure") {
          if (event.payload?.sessionId && event.payload.sessionId !== currentPinned) {
            return;
          }
        }

        sendSseEvent(res, event.type, event.payload);
      });

      const heartbeat = setInterval(() => {
        res.write(": ping\n\n");
        sendSseEvent(res, "heartbeat", { time: new Date().toISOString() });
      }, 15000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    sendJson(res, 404, {
      error: {
        code: "NOT_FOUND",
        message: "API route not found.",
      },
      ok: false,
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    const statusCode = error instanceof BridgeError && error.code === "SEND_FAILED"
      ? 409
      : error instanceof BridgeError
        ? error.statusCode
        : 500;
    sendJson(res, statusCode, payload);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (parsedUrl.pathname === "/auth/login") {
    if (isAuthorized(req)) {
      redirect(res, "/");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      sendLoginPage(res, { error: parsedUrl.searchParams.get("error") === "1", headOnly: req.method === "HEAD" });
      return;
    }

    if (req.method === "POST") {
      const formBody = await readRawBody(req, 8 * 1024);
      const form = new URLSearchParams(formBody);
      if (isValidCredentialPair(form.get("username") || "", form.get("password") || "")) {
        const usesHttps = requestUsesHttps(req);
        const authToken = signCookieAuth(basicAuthUser);
        sendLoginSuccessPage(res, {
          "set-cookie": [
            buildAuthCookieHeader(authToken, 60 * 60 * 24 * 7, {
              secure: usesHttps,
            }),
            buildAuthCookieHeader(authToken, 60 * 60 * 24 * 7, {
              httpOnly: false,
              name: fallbackCookieAuthName,
              secure: usesHttps,
            }),
          ],
        }, {
          cookieToken: authToken,
          secure: usesHttps,
        });
        return;
      }

      redirect(res, "/auth/login?error=1", { "set-cookie": clearAuthCookieHeader(req) });
      return;
    }

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  if (parsedUrl.pathname === "/auth/check") {
    sendAuthCheck(res, req);
    return;
  }

  if (parsedUrl.pathname === "/auth/logout") {
    redirect(res, "/auth/login", { "set-cookie": clearAuthCookieHeader(req) });
    return;
  }

  if (!isAuthorized(req)) {
    requestAuth(res, req);
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/")) {
    await handleApi(req, res, parsedUrl);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const filePath = resolveRequestedFile(parsedUrl.pathname);
  if (!filePath) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  try {
    const fileContent = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = contentTypeByExt[ext] || "application/octet-stream";
    res.writeHead(200, {
      ...NO_STORE_HEADERS,
      "content-type": contentType,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(fileContent);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `Codex2Web dev server listening on http://${host}:${port} with provider=${requestedProvider}\n`,
  );
  if (requiresExternalAuthBoundary) {
    process.stdout.write("External mode active: auth boundary enforced.\n");
  }
});
