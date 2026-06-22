import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError, LocalSessionBridge } from "./local-bridge.js";

const port = Number(process.env.PORT || "4321");
const host = process.env.HOST || "127.0.0.1";
const externalMode = process.env.CODEX2WEB_EXTERNAL === "true";
const externalTrustedMode =
  process.env.CODEX2WEB_REMOTE_TRUSTED === "true" || process.env.CODEX2WEB_EXTERNAL_TRUSTED === "true";
const basicAuthUser = process.env.CODEX2WEB_BASIC_USER || "";
const basicAuthPass = process.env.CODEX2WEB_BASIC_PASS || "";
const requestedExecutionProfile = String(process.env.CODEX2WEB_EXECUTION_PROFILE || "").trim();
const codexBinaryPath = process.env.CODEX2WEB_CODEX_BINARY || undefined;
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const auditFilePath = path.join(projectRoot, ".codex2web", "session-audit.jsonl");
const clientSessionPinsFilePath = path.join(projectRoot, ".codex2web", "client-session-pins.json");
const stateFilePath = path.join(projectRoot, ".codex2web", "session-pin.json");
const uploadDir = path.join(projectRoot, ".codex2web", "uploads");
const defaultCodexBinaryPath = path.join(os.homedir(), ".bun", "bin", "codex");
const authEnabled = basicAuthUser.length > 0 && basicAuthPass.length > 0;
const isHostLocalOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const requiresExternalAuthBoundary = externalMode || !isHostLocalOnly;

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

const bridge = new LocalSessionBridge({
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
  return (
    normalizeClientId(req.headers["x-codex2web-client-id"]) ||
    normalizeClientId(parsedUrl.searchParams.get("clientId") || "")
  );
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

function isAuthorized(req) {
  if (!authEnabled) {
    return true;
  }

  const credentials = decodeBasicAuthHeader(req.headers.authorization);
  if (!credentials) {
    return false;
  }

  return credentials.user === basicAuthUser && credentials.pass === basicAuthPass;
}

function requestAuth(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Codex2Web External Access", charset="UTF-8"',
  });
  res.end("Authentication Required");
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
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
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
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
      sendJson(res, 200, {
        auditTrail: bridge.getAuditTrail(20),
        binding,
        failureModes: bridge.getFailureModes(),
        ok: true,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/snapshot") {
      await bridge.discoverSessions();
      const afterId = String(parsedUrl.searchParams.get("after") || "");
      const forceFull = String(parsedUrl.searchParams.get("force") || "").toLowerCase() === "full";
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        failureModes: bridge.getFailureModes(),
        ok: true,
        snapshot: await bridge.getTranscriptSnapshot({ afterId, forceFull, sessionId: clientSessionId }),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session/history") {
      await bridge.discoverSessions();
      const beforeId = String(parsedUrl.searchParams.get("before") || "");
      const requestedLimit = Number(parsedUrl.searchParams.get("limit") || HISTORY_TRANSCRIPT_PAGE_LIMIT);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
        : HISTORY_TRANSCRIPT_PAGE_LIMIT;
      sendJson(res, 200, {
        binding: bridge.getBinding(clientSessionId),
        history: await bridge.getTranscriptHistoryPage({
          beforeId,
          limit,
          sessionId: clientSessionId,
        }),
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
        execution: bridge.getExecutionPolicy(),
        executionRuntime: bridge.getExecutionRuntimeConfig(),
        externalMode: requiresExternalAuthBoundary,
        host,
        ok: true,
        port,
        runtime: getRuntimeReadiness(),
        security: {
          authEnabled,
          authMode: authEnabled ? "basic" : "none",
          remoteTrusted: requiresExternalAuthBoundary ? externalTrustedMode : false,
        },
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
      const result = await bridge.sendInput(body.message, { imagePaths, sessionId: clientSessionId });
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
      const replayEntries = afterId && !snapshot.reset ? snapshot.entries : snapshot.entries.slice(-20);
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
    const statusCode = error instanceof BridgeError ? error.statusCode : 500;
    sendJson(res, statusCode, payload);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");

  if (!isAuthorized(req)) {
    requestAuth(res);
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
  process.stdout.write(`Codex2Web dev server listening on http://${host}:${port}\n`);
  if (requiresExternalAuthBoundary) {
    process.stdout.write("External mode active: auth boundary enforced.\n");
  }
});
