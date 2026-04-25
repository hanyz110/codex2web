#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_PORT = 4321;
const READY_TIMEOUT_MS = 20_000;
const PUBLIC_URL_TIMEOUT_MS = 45_000;
const PUBLIC_VERIFY_TIMEOUT_MS = 60_000;

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
  const useNamedTunnel =
    args["named-tunnel"] === "true" ||
    process.env.CODEX2WEB_NAMED_TUNNEL === "true" ||
    Boolean(tunnelName || tunnelId || hostname || credentialsFile);

  return {
    credentialsFile,
    hostname,
    tunnelId,
    tunnelName,
    useNamedTunnel,
  };
}

async function createNamedTunnelConfig({ credentialsFile, hostname, port, tunnelId }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex2web-cloudflared-"));
  const configPath = path.join(tempDir, "config.yml");
  const configContent = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
  await writeFile(configPath, configContent, "utf-8");
  return { configPath, tempDir };
}

async function buildTunnelCommand(provider, port, namedTunnelOptions) {
  if (provider === "cloudflared") {
    const localBinaryPath = path.resolve(".codex2web-tools", "cloudflared");
    const cloudflaredBinary =
      process.env.CLOUDFLARED_BIN || (existsSync(localBinaryPath) ? localBinaryPath : "cloudflared");

    if (namedTunnelOptions?.useNamedTunnel) {
      const { credentialsFile, hostname, tunnelId, tunnelName } = namedTunnelOptions;
      if (!tunnelId || !hostname || !credentialsFile) {
        throw new Error(
          "Named tunnel mode requires --tunnel-id, --hostname, and --credentials-file (or the matching CODEX2WEB_CLOUDFLARE_* env vars).",
        );
      }
      if (!existsSync(credentialsFile)) {
        throw new Error(`Named tunnel credentials file not found: ${credentialsFile}`);
      }

      const tempConfig = await createNamedTunnelConfig({
        credentialsFile,
        hostname,
        port,
        tunnelId,
      });
      return {
        args: ["tunnel", "--config", tempConfig.configPath, "run", tunnelName || tunnelId],
        cleanupPaths: [tempConfig.tempDir],
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

  const serverChild = spawn(process.execPath, ["src/server/dev-server.js"], {
    env: {
      ...process.env,
      CODEX2WEB_BASIC_PASS: basicPass,
      CODEX2WEB_BASIC_USER: basicUser,
      CODEX2WEB_EXTERNAL: "true",
      CODEX2WEB_REMOTE_TRUSTED: remoteTrusted ? "true" : "false",
      HOST: "0.0.0.0",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  streamChild("server", serverChild);
  let tunnelCleanupPaths = [];

  const cleanup = () => {
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
  tunnelChild = spawn(tunnelCommand.cmd, tunnelCommand.args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  streamChild(tunnelCommand.displayName, tunnelChild);

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

  await Promise.race([
    new Promise((resolve, reject) => {
      serverChild.on("close", (code) => {
        reject(new Error(`External server exited unexpectedly with code ${String(code)}.`));
      });
      tunnelChild.on("close", (code) => {
        reject(new Error(`Tunnel exited unexpectedly with code ${String(code)}.`));
      });
    }),
    new Promise(() => {}),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
});
