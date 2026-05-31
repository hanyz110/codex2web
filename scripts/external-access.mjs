#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_PORT = 4321;
const READY_TIMEOUT_MS = 20_000;
const PUBLIC_URL_TIMEOUT_MS = 45_000;
const PUBLIC_VERIFY_TIMEOUT_MS = 60_000;
const PUBLIC_WATCHDOG_FAILURES = 6;
const PUBLIC_WATCHDOG_INTERVAL_MS = 15_000;
const PUBLIC_WATCHDOG_RESTART_COOLDOWN_MS = 120_000;
const PUBLIC_WATCHDOG_TIMEOUT_MS = 10_000;

function buildRuntimePath(env = process.env) {
  const homeDir = env.HOME || process.env.HOME || "";
  const candidates = [
    homeDir ? path.join(homeDir, ".bun", "bin") : "",
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const existing = String(env.PATH || "")
    .split(":")
    .filter(Boolean);
  const seen = new Set();
  return [...candidates, ...existing]
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    })
    .join(":");
}

function buildRuntimeEnv(overrides = {}) {
  const baseEnv = { ...process.env, ...overrides };
  return {
    ...baseEnv,
    PATH: buildRuntimePath(baseEnv),
  };
}

function parseArgs(argv) {
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function authHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function isExplicitlyDisabled(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").toLowerCase());
}

function pickProvider(explicitProvider) {
  if (explicitProvider) {
    return explicitProvider;
  }

  return "cloudflared";
}

function resolveNamedTunnelOptions(args) {
  const tunnelName =
    args["tunnel-name"] ||
    process.env.CODEX2WEB_CLOUDFLARE_TUNNEL_NAME ||
    process.env.CODEX2WEB_CF_TUNNEL_NAME ||
    "";
  const tunnelId =
    args["tunnel-id"] ||
    process.env.CODEX2WEB_CLOUDFLARE_TUNNEL_ID ||
    process.env.CODEX2WEB_CF_TUNNEL_ID ||
    "";
  const hostname =
    args.hostname ||
    process.env.CODEX2WEB_CLOUDFLARE_HOSTNAME ||
    process.env.CODEX2WEB_CF_HOSTNAME ||
    "";
  const credentialsFile =
    args["credentials-file"] ||
    process.env.CODEX2WEB_CLOUDFLARE_CREDENTIALS_FILE ||
    process.env.CODEX2WEB_CF_CREDENTIALS_FILE ||
    "";
  const configFile =
    args["config-file"] ||
    process.env.CODEX2WEB_CLOUDFLARE_CONFIG_FILE ||
    process.env.CODEX2WEB_CF_CONFIG_FILE ||
    "";
  const useNamedTunnel =
    args["named-tunnel"] === "true" ||
    process.env.CODEX2WEB_NAMED_TUNNEL === "true" ||
    Boolean(tunnelName || tunnelId || hostname || credentialsFile);

  return {
    credentialsFile,
    configFile,
    hostname,
    tunnelId,
    tunnelName,
    useNamedTunnel,
  };
}

function safeFileSegment(value) {
  return String(value || "default")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

async function createNamedTunnelConfig({ configFile, credentialsFile, hostname, port, tunnelId, tunnelName }) {
  const tunnelProtocol = process.env.CODEX2WEB_CLOUDFLARE_PROTOCOL || process.env.TUNNEL_TRANSPORT_PROTOCOL || "http2";
  const configPath = configFile
    ? path.resolve(configFile)
    : path.resolve(
        process.env.CODEX2WEB_RUNTIME_DIR || ".codex2web/runtime",
        `cloudflared-${safeFileSegment(tunnelName || tunnelId)}.yml`,
      );
  const configContent = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    `protocol: ${tunnelProtocol}`,
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, configContent, "utf-8");
  return { configPath };
}

async function buildTunnelCommand(provider, port, namedTunnelOptions) {
  if (provider === "cloudflared") {
    const localBinaryPath = path.resolve(".codex2web-tools", "cloudflared");
    const cloudflaredBinary =
      process.env.CLOUDFLARED_BIN || (existsSync(localBinaryPath) ? localBinaryPath : "cloudflared");

    if (namedTunnelOptions?.useNamedTunnel) {
      const { configFile, credentialsFile, hostname, tunnelId, tunnelName } = namedTunnelOptions;
      if (!tunnelId || !hostname || !credentialsFile) {
        throw new Error(
          "Named tunnel mode requires --tunnel-id, --hostname, and --credentials-file (or the matching CODEX2WEB_CLOUDFLARE_* env vars).",
        );
      }
      if (!existsSync(credentialsFile)) {
        throw new Error(`Named tunnel credentials file not found: ${credentialsFile}`);
      }

      const tempConfig = await createNamedTunnelConfig({
        configFile,
        credentialsFile,
        hostname,
        port,
        tunnelId,
        tunnelName,
      });
      return {
        args: ["tunnel", "--config", tempConfig.configPath, "run", tunnelName || tunnelId],
        cleanupPaths: [],
        cmd: cloudflaredBinary,
        displayName: "cloudflared",
        publicUrl: `https://${hostname}`,
        startupMode: "named-tunnel",
      };
    }

    return {
      args: ["tunnel", "--url", `http://127.0.0.1:${port}`],
      cmd: cloudflaredBinary,
      displayName: "cloudflared",
      publicUrl: null,
      startupMode: "quick-tunnel",
    };
  }

  if (provider === "localtunnel") {
    return {
      args: ["--yes", "localtunnel", "--port", String(port)],
      cmd: "npx",
      displayName: "localtunnel",
      publicUrl: null,
      startupMode: "quick-tunnel",
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function waitForLocalReady(port, user, pass) {
  const startedAt = Date.now();
  const url = `http://127.0.0.1:${port}/api/system/meta`;

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    try {
      const response = await fetch(url, {
        headers: {
          authorization: authHeader(user, pass),
        },
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Keep polling until timeout.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for local external-mode server on port ${String(port)}.`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PUBLIC_WATCHDOG_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyPublicUrl(publicUrl, user, pass) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < PUBLIC_VERIFY_TIMEOUT_MS) {
    try {
      const unauthorized = await fetch(publicUrl, { redirect: "manual" });
      const authorized = await fetch(`${publicUrl}/api/system/meta`, {
        headers: {
          authorization: authHeader(user, pass),
        },
      });

      let meta = null;
      try {
        meta = await authorized.json();
      } catch {
        meta = null;
      }

      const snapshot = {
        authorizedOk: authorized.ok,
        authMode: meta?.security?.authMode || null,
        executionProfile: meta?.execution?.profile || null,
        externalMode: meta?.externalMode || false,
        unauthorizedStatus: unauthorized.status,
      };

      if (snapshot.unauthorizedStatus === 401 && snapshot.authorizedOk) {
        return snapshot;
      }

      lastError = new Error(
        `Public URL verification not ready yet (status=${String(snapshot.unauthorizedStatus)}, authOk=${String(snapshot.authorizedOk)}).`,
      );
    } catch (error) {
      lastError = error;
    }

    await delay(1000);
  }

  throw new Error(
    `Timed out verifying public URL. Last error: ${String(lastError?.message || lastError || "unknown")}`,
  );
}

async function probePublicHealth(publicUrl, user, pass, timeoutMs) {
  const unauthorized = await fetchWithTimeout(publicUrl, { redirect: "manual" }, timeoutMs);
  const authorized = await fetchWithTimeout(
    `${publicUrl}/api/system/meta`,
    {
      headers: {
        authorization: authHeader(user, pass),
      },
    },
    timeoutMs,
  );

  if (unauthorized.status !== 401 || !authorized.ok) {
    throw new Error(
      `public health failed: unauth=${String(unauthorized.status)} auth=${String(authorized.status)}`,
    );
  }
}

function startPublicWatchdog({ onSustainedFailure, publicUrl, user, pass }) {
  if (isExplicitlyDisabled(process.env.CODEX2WEB_PUBLIC_WATCHDOG)) {
    process.stdout.write("Public watchdog disabled by CODEX2WEB_PUBLIC_WATCHDOG.\n");
    return null;
  }

  const intervalMs = parsePositiveInt(process.env.CODEX2WEB_PUBLIC_WATCHDOG_INTERVAL_MS, PUBLIC_WATCHDOG_INTERVAL_MS);
  const restartCooldownMs = parsePositiveInt(
    process.env.CODEX2WEB_PUBLIC_WATCHDOG_RESTART_COOLDOWN_MS,
    PUBLIC_WATCHDOG_RESTART_COOLDOWN_MS,
  );
  const failureThreshold = parsePositiveInt(
    process.env.CODEX2WEB_PUBLIC_WATCHDOG_FAILURES,
    PUBLIC_WATCHDOG_FAILURES,
  );
  const timeoutMs = parsePositiveInt(process.env.CODEX2WEB_PUBLIC_WATCHDOG_TIMEOUT_MS, PUBLIC_WATCHDOG_TIMEOUT_MS);
  let consecutiveFailures = 0;
  let lastRestartAt = 0;
  let running = false;

  process.stdout.write(
    `Public watchdog enabled: interval=${String(intervalMs)}ms failures=${String(failureThreshold)} timeout=${String(timeoutMs)}ms restartCooldown=${String(restartCooldownMs)}ms.\n`,
  );

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await probePublicHealth(publicUrl, user, pass, timeoutMs);
      if (consecutiveFailures > 0) {
        process.stderr.write("[watchdog] public health recovered.\n");
      }
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      process.stderr.write(
        `[watchdog] public health failure ${String(consecutiveFailures)}/${String(failureThreshold)}: ${String(
          error.message || error,
        )}\n`,
      );
      if (consecutiveFailures >= failureThreshold) {
        const now = Date.now();
        if (now - lastRestartAt < restartCooldownMs) {
          process.stderr.write(
            "[watchdog] public health failure threshold reached, but tunnel restart is still cooling down.\n",
          );
          consecutiveFailures = Math.max(1, failureThreshold - 1);
          return;
        }

        lastRestartAt = now;
        process.stderr.write("[watchdog] public health failure threshold reached; restarting tunnel only.\n");
        consecutiveFailures = 0;
        try {
          await onSustainedFailure?.();
        } catch (restartError) {
          process.stderr.write(
            `[watchdog] tunnel restart failed; keeping server alive: ${String(
              restartError.message || restartError,
            )}\n`,
          );
        }
      }
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  interval.unref?.();
  return interval;
}

function capturePublicUrl(child, provider) {
  const publicUrlPattern =
    provider === "cloudflared"
      ? /https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/
      : /https:\/\/[-a-zA-Z0-9.]+(?:loca\.lt|localto\.net)/;

  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const maybeResolve = (chunk) => {
      if (settled) {
        return;
      }

      const text = chunk.toString("utf-8");
      const match = text.match(publicUrlPattern);
      if (match?.[0]) {
        settled = true;
        resolve(match[0]);
      }
    };

    child.stdout.on("data", maybeResolve);
    child.stderr.on("data", maybeResolve);
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Tunnel process exited before publishing a URL (code ${String(code)}).`));
      }
    });

    const interval = setInterval(() => {
      if (settled) {
        clearInterval(interval);
        return;
      }

      if (Date.now() - startedAt >= PUBLIC_URL_TIMEOUT_MS) {
        settled = true;
        clearInterval(interval);
        reject(new Error(`Timed out waiting for public URL from ${provider}.`));
      }
    }, 500);
    interval.unref?.();
  });
}

async function cleanupPaths(paths) {
  for (const targetPath of paths || []) {
    if (!targetPath) {
      continue;
    }
    try {
      await rm(targetPath, { force: true, recursive: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function streamChild(prefix, child) {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${prefix}] ${chunk.toString("utf-8")}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${prefix}] ${chunk.toString("utf-8")}`);
  });
}

function waitForChildClose(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "launch";

  if (command !== "launch") {
    throw new Error(`Unknown command: ${command}`);
  }

  const port = Number(args.port || process.env.PORT || DEFAULT_PORT);
  const provider = pickProvider(args.provider || process.env.CODEX2WEB_TUNNEL_PROVIDER);
  const namedTunnelOptions = resolveNamedTunnelOptions(args);
  const basicUser = process.env.CODEX2WEB_BASIC_USER || args.user || "codex2web";
  const basicPass = process.env.CODEX2WEB_BASIC_PASS || args.pass || randomPassword();
  const remoteTrusted =
    args["remote-trusted"] === "true" ||
    process.env.CODEX2WEB_REMOTE_TRUSTED === "true" ||
    process.env.CODEX2WEB_EXTERNAL_TRUSTED === "true";
  const allowUnverifiedPublic =
    args["allow-unverified-public"] === "true" || process.env.CODEX2WEB_ALLOW_UNVERIFIED_PUBLIC === "true";

  const serviceEnv = buildRuntimeEnv({
    CODEX2WEB_BASIC_PASS: basicPass,
    CODEX2WEB_BASIC_USER: basicUser,
    CODEX2WEB_EXTERNAL: "true",
    CODEX2WEB_REMOTE_TRUSTED: remoteTrusted ? "true" : "false",
    HOST: "0.0.0.0",
    PORT: String(port),
  });
  process.env.PATH = serviceEnv.PATH;

  const serverChild = spawn(process.execPath, ["src/server/dev-server.js"], {
    env: {
      ...serviceEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  streamChild("server", serverChild);
  let tunnelCleanupPaths = [];
  let isShuttingDown = false;
  let plannedTunnelRestart = false;

  const cleanup = () => {
    isShuttingDown = true;
    serverChild.kill("SIGTERM");
    if (tunnelChild) {
      tunnelChild.kill("SIGTERM");
    }
    void cleanupPaths(tunnelCleanupPaths);
  };

  let tunnelChild = null;

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);

  const meta = await waitForLocalReady(port, basicUser, basicPass);
  const tunnelCommand = await buildTunnelCommand(provider, port, namedTunnelOptions);
  tunnelCleanupPaths = tunnelCommand.cleanupPaths || [];
  if (provider === "cloudflared" && tunnelCommand.startupMode === "named-tunnel") {
    process.stdout.write(
      `Using Cloudflare named tunnel for stable hostname: ${namedTunnelOptions.hostname}\n`,
    );
  } else if (provider === "cloudflared") {
    process.stdout.write("Using cloudflared for the cleanest phone-friendly external URL.\n");
  } else if (provider === "localtunnel") {
    process.stdout.write(
      "Using localtunnel fallback. Note: some browsers may show a localtunnel reminder page before the app.\n",
    );
  }
  if (remoteTrusted) {
    process.stdout.write(
      "Remote trusted mode enabled: the external browser entry will run with local-equivalent dangerous execution authority.\n",
    );
  }
  const spawnTunnelChild = () => {
    const child = spawn(tunnelCommand.cmd, tunnelCommand.args, {
      env: serviceEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    streamChild(tunnelCommand.displayName, child);
    child.on("close", (code) => {
      if (isShuttingDown || plannedTunnelRestart) {
        return;
      }
      process.stderr.write(
        `[watchdog] tunnel exited unexpectedly with code ${String(code)}; restarting tunnel only.\n`,
      );
      tunnelChild = spawnTunnelChild();
    });
    return child;
  };

  const restartTunnelOnly = async () => {
    if (!tunnelChild) {
      tunnelChild = spawnTunnelChild();
      return;
    }

    const oldTunnelChild = tunnelChild;
    plannedTunnelRestart = true;
    oldTunnelChild.kill("SIGTERM");
    const closed = await waitForChildClose(oldTunnelChild);
    if (!closed) {
      oldTunnelChild.kill("SIGKILL");
      await waitForChildClose(oldTunnelChild, 2_000);
    }
    plannedTunnelRestart = false;
    tunnelChild = spawnTunnelChild();
  };

  tunnelChild = spawnTunnelChild();

  const publicUrl = tunnelCommand.publicUrl || (await capturePublicUrl(tunnelChild, provider));
  let verification = null;
  let verificationWarning = "";

  try {
    verification = await verifyPublicUrl(publicUrl, basicUser, basicPass);
  } catch (error) {
    if (!allowUnverifiedPublic) {
      throw error;
    }
    verificationWarning = String(error.message || error);
    verification = {
      authMode: "unknown",
      executionProfile: "unknown",
      externalMode: true,
      unauthorizedStatus: "unverified",
    };
  }

  process.stdout.write(
    [
      "",
      "Codex2Web external access is ready.",
      `Provider: ${provider}`,
      `Tunnel mode: ${tunnelCommand.startupMode || "unknown"}`,
      `Local port: ${String(port)}`,
      `Public URL: ${publicUrl}`,
      `Basic Auth user: ${basicUser}`,
      `Basic Auth pass: ${basicPass}`,
      `Remote trusted: ${remoteTrusted ? "enabled" : "disabled"}`,
      `Public verify unauth status: ${String(verification.unauthorizedStatus)}`,
      `Public verify authMode: ${verification.authMode || "unknown"}`,
      `Public verify execution profile: ${verification.executionProfile || "unknown"}`,
      ...(verificationWarning
        ? [
            "Public verify warning:",
            verificationWarning,
            "Continuing because --allow-unverified-public is enabled.",
          ]
        : []),
      "",
      "Keep this process running while using the phone URL. Press Ctrl+C to shut down both the tunnel and server.",
      "",
    ].join("\n"),
  );

  startPublicWatchdog({
    onSustainedFailure: restartTunnelOnly,
    pass: basicPass,
    publicUrl,
    user: basicUser,
  });

  await Promise.race([
    new Promise((resolve, reject) => {
      serverChild.on("close", (code) => {
        reject(new Error(`External server exited unexpectedly with code ${String(code)}.`));
      });
    }),
    new Promise(() => {}),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
});
