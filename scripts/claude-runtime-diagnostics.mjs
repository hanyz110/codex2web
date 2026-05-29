#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API_PROBE_ENABLED = process.argv.includes("--api-probe");
const DEFAULT_MODEL = process.env.CLAUDE2WEB_DIAGNOSTIC_MODEL || "";

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function redactValue(key, value) {
  if (!value) {
    return "<unset>";
  }

  if (key.endsWith("URL")) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
    } catch {
      return "<set non-url>";
    }
  }

  return `<set length ${String(value).length}>`;
}

async function loadClaudeSettingsEnv() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf-8"));
    return parsed.env && typeof parsed.env === "object" ? parsed.env : {};
  } catch {
    return {};
  }
}

async function runCommand(command, args) {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    });
    return {
      ok: true,
      stderr: stderr.trim(),
      stdout: stdout.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || error),
      stderr: String(error.stderr || "").trim(),
      stdout: String(error.stdout || "").trim(),
    };
  }
}

function resolveClaudeEnv(settingsEnv) {
  return {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY || "",
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_AUTH_TOKEN || "",
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL || "",
    ANTHROPIC_DEFAULT_SONNET_MODEL:
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || settingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || "",
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || settingsEnv.ANTHROPIC_MODEL || "",
  };
}

async function probeMessagesEndpoint(env) {
  if (!API_PROBE_ENABLED) {
    return {
      skipped: true,
      reason: "Pass --api-probe to POST a one-token request to ANTHROPIC_BASE_URL/v1/messages.",
    };
  }

  if (!env.ANTHROPIC_BASE_URL) {
    return {
      skipped: true,
      reason: "ANTHROPIC_BASE_URL is unset.",
    };
  }

  const credential = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!credential) {
    return {
      skipped: true,
      reason: "No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN available.",
    };
  }

  const baseUrl = env.ANTHROPIC_BASE_URL.endsWith("/")
    ? env.ANTHROPIC_BASE_URL
    : `${env.ANTHROPIC_BASE_URL}/`;
  const endpoint = new URL("v1/messages", baseUrl).toString();
  const model = DEFAULT_MODEL || env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || "claude-sonnet-4-6";
  const headers = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (env.ANTHROPIC_API_KEY) {
    headers["x-api-key"] = credential;
  } else {
    headers.authorization = `Bearer ${credential}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: "Reply with OK", role: "user" }],
        model,
      }),
      headers,
      method: "POST",
      signal: controller.signal,
    });
    const body = await response.text();
    const parsed = safeJsonParse(body);

    return {
      bodyPrefix: parsed ? undefined : body.slice(0, 160).replace(/\s+/g, " "),
      contentType: response.headers.get("content-type") || "",
      endpoint: new URL(endpoint).origin + new URL(endpoint).pathname,
      errorMessage: parsed?.error?.message || parsed?.message || "",
      httpStatus: response.status,
      jsonType: parsed?.type || parsed?.error?.type || "",
      model,
      ok: response.ok && Boolean(parsed),
    };
  } catch (error) {
    return {
      error: String(error.message || error),
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const settingsEnv = await loadClaudeSettingsEnv();
const claudeEnv = resolveClaudeEnv(settingsEnv);
const whichClaude = await runCommand("which", ["claude"]);
const version = await runCommand("claude", ["--version"]);
const authStatus = await runCommand("claude", ["auth", "status"]);

const report = {
  apiProbe: await probeMessagesEndpoint(claudeEnv),
  authStatus: safeJsonParse(authStatus.stdout) || {
    ok: authStatus.ok,
    stderr: authStatus.stderr,
    stdout: authStatus.stdout,
  },
  env: Object.fromEntries(
    Object.entries(claudeEnv).map(([key, value]) => [key, redactValue(key, value)]),
  ),
  settingsEnvKeys: Object.keys(settingsEnv).sort(),
  version: version.stdout || version.stderr || version.error,
  whichClaude: whichClaude.stdout || whichClaude.stderr || whichClaude.error,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
