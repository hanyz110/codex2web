#!/usr/bin/env node

import dns from "node:dns/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_PUBLIC_URL = "https://codex2web.idea-search.com";
const DEFAULT_PORT = 4422;
const DEFAULT_USER = "codex2web";
const DEFAULT_TIMEOUT_MS = 12_000;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function probeMeta(url, user, pass) {
  const response = await fetchWithTimeout(`${url}/api/system/meta`, {
    headers: { authorization: authHeader(user, pass) },
  });
  return { body: await readJson(response), ok: response.ok, status: response.status };
}

async function probeHealth({ localUrl, pass, publicUrl, user }) {
  const hostname = new URL(publicUrl).hostname;
  const dnsAddresses = await dns.resolve4(hostname).catch(() => []);
  const localMeta = await probeMeta(localUrl, user, pass);
  const publicUnauth = await fetchWithTimeout(publicUrl, { redirect: "manual" });
  const publicMeta = await probeMeta(publicUrl, user, pass);

  const checks = {
    dns: dnsAddresses.length > 0,
    localMeta: localMeta.ok,
    localRuntimeBun: localMeta.body?.runtime?.bunAvailable === true && localMeta.body?.runtime?.pathHasBunBin === true,
    publicAuthBoundary: publicUnauth.status === 401,
    publicMeta: publicMeta.ok,
    publicExternalMode: publicMeta.body?.externalMode === true,
    publicRuntimeBun: publicMeta.body?.runtime?.bunAvailable === true && publicMeta.body?.runtime?.pathHasBunBin === true,
  };
  const ok = Object.values(checks).every(Boolean);

  return {
    checks,
    dnsAddresses,
    local: {
      executionProfile: localMeta.body?.execution?.profile || null,
      externalMode: localMeta.body?.externalMode || false,
      status: localMeta.status,
    },
    ok,
    public: {
      authMode: publicMeta.body?.security?.authMode || null,
      executionProfile: publicMeta.body?.execution?.profile || null,
      externalMode: publicMeta.body?.externalMode || false,
      metaStatus: publicMeta.status,
      unauthStatus: publicUnauth.status,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const attempts = Number(args.attempts || process.env.CODEX2WEB_HEALTH_ATTEMPTS || 1);
  const localPort = Number(args["local-port"] || process.env.CODEX2WEB_EXTERNAL_PORT || DEFAULT_PORT);
  const localUrl = args["local-url"] || process.env.CODEX2WEB_LOCAL_URL || `http://127.0.0.1:${localPort}`;
  const publicUrl = args.url || process.env.CODEX2WEB_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  const user = args.user || process.env.CODEX2WEB_BASIC_USER || DEFAULT_USER;
  const pass = args.pass || process.env.CODEX2WEB_BASIC_PASS;

  if (!pass) {
    throw new Error("Missing Basic Auth password. Set CODEX2WEB_BASIC_PASS or pass --pass.");
  }

  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastResult = await probeHealth({ localUrl, pass, publicUrl, user });
      if (lastResult.ok) {
        process.stdout.write(`${JSON.stringify({ ...lastResult, attempt, status: "healthy" }, null, 2)}\n`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await delay(1000);
    }
  }

  const output = lastResult || { error: String(lastError?.message || lastError || "unknown"), ok: false };
  process.stderr.write(`${JSON.stringify({ ...output, status: "unhealthy" }, null, 2)}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
});
