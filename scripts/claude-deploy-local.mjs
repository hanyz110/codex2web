#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const APP_LABEL = "com.claude2web.app";
const EXPECTED_BRANCH = "codex/provider-claude";
const EXPECTED_WORKTREE_BASENAME = "codex2web-claude-lab";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "4522";
const DEFAULT_PUBLIC_URL = "https://claude2web.idea-search.com";

const SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "claude2web");
const RUNTIME_DIR = path.join(SUPPORT_DIR, "app-runtime");
const ENV_PATH = path.join(SUPPORT_DIR, "launchd.env");
const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "claude2web");
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
const RUNTIME_LINK = path.join(os.homedir(), "claude2web-app-runtime");
const ENV_LINK = path.join(os.homedir(), "claude2web-launchd.env");

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      stdio: options.stdio || "pipe",
      ...options,
    });
  } catch (error) {
    if (options.ignoreFailure) {
      return "";
    }
    throw error;
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function authHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function fetchStatus(url, { auth, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: auth ? { authorization: auth } : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchResponse(url, { auth, method = "GET", body, headers = {}, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      body,
      headers: {
        ...headers,
        ...(auth ? { authorization: auth } : {}),
      },
      method,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureSymlink(linkPath, targetPath) {
  await unlink(linkPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
  await symlink(targetPath, linkPath);
}

function getRepoRoot() {
  return run("git", ["rev-parse", "--show-toplevel"]).trim();
}

function getBranch() {
  return run("git", ["branch", "--show-current"]).trim();
}

function assertLabWorktree(repoRoot) {
  const branch = getBranch();
  const basename = path.basename(repoRoot);

  if (basename !== EXPECTED_WORKTREE_BASENAME) {
    throw new Error(
      `Refusing to deploy from ${repoRoot}. Expected worktree basename ${EXPECTED_WORKTREE_BASENAME}.`,
    );
  }

  if (branch !== EXPECTED_BRANCH) {
    throw new Error(`Refusing to deploy branch ${branch || "unknown"}. Expected ${EXPECTED_BRANCH}.`);
  }
}

function readLaunchEnv() {
  const output = run("/bin/zsh", [
    "-lc",
    [
      `set -a`,
      `source ${JSON.stringify(ENV_LINK)}`,
      `set +a`,
      `printf '%s\\n%s\\n%s\\n%s\\n' "$CODEX2WEB_BASIC_USER" "$CODEX2WEB_BASIC_PASS" "$HOST" "$PORT"`,
    ].join(" && "),
  ]);
  const [user, pass, host, port] = output.split("\n");
  if (!user || !pass) {
    throw new Error("Missing CODEX2WEB_BASIC_USER or CODEX2WEB_BASIC_PASS in claude2web launchd env.");
  }
  return {
    host: host || DEFAULT_HOST,
    pass,
    port: port || DEFAULT_PORT,
    user,
  };
}

async function writeAppPlist() {
  const command = [
    `cd ${JSON.stringify(RUNTIME_DIR)}`,
    `export PWD=${JSON.stringify(RUNTIME_DIR)}`,
    "set -a",
    `source ${JSON.stringify(ENV_PATH)}`,
    "set +a",
    "exec npm start",
  ].join(" && ");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(APP_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(RUNTIME_DIR)}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(LOG_DIR, "app.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(LOG_DIR, "app.err.log"))}</string>
</dict>
</plist>
`;

  await mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await writeFile(PLIST_PATH, plist, "utf-8");
}

function restartLaunchAgent() {
  const uid = process.getuid?.() || Number(run("id", ["-u"]).trim());
  const domain = `gui/${uid}`;
  run("launchctl", ["bootout", domain, PLIST_PATH], { ignoreFailure: true });
  run("launchctl", ["bootstrap", domain, PLIST_PATH]);
  run("launchctl", ["enable", `${domain}/${APP_LABEL}`], { ignoreFailure: true });
  run("launchctl", ["kickstart", "-k", `${domain}/${APP_LABEL}`]);
}

function rsyncRuntime(repoRoot) {
  run("rsync", [
    "-a",
    "--delete",
    "--exclude",
    ".git",
    "--exclude",
    ".DS_Store",
    "--exclude",
    "node_modules",
    "--exclude",
    ".codex2web/",
    `${repoRoot}/`,
    `${RUNTIME_DIR}/`,
  ]);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeExpectedStatus(name, url, expected, options = {}) {
  const attempts = Number(options.attempts || 8);
  const intervalMs = Number(options.intervalMs || 1000);
  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastStatus = await fetchStatus(url, options);
      if (lastStatus === expected) {
        process.stdout.write(`${name}: ${lastStatus}\n`);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await delay(intervalMs);
    }
  }

  if (lastError) {
    throw new Error(`${name} expected ${expected}, last error: ${lastError.message || lastError}`);
  }
  throw new Error(`${name} expected ${expected}, got ${lastStatus}`);
}

async function verifyHttp({ publicUrl }) {
  const env = readLaunchEnv();
  const base = `http://${env.host || DEFAULT_HOST}:${env.port || DEFAULT_PORT}`;
  const auth = authHeader(env.user, env.pass);

  await probeExpectedStatus("local unauth /", `${base}/`, 302, { attempts: 30 });
  await probeExpectedStatus("local auth /", `${base}/`, 200, { attempts: 30, auth });
  await probeExpectedStatus("local auth /app.js", `${base}/app.js`, 200, { attempts: 30, auth });
  await probeExpectedStatus("local auth /app.css", `${base}/app.css`, 200, { attempts: 30, auth });
  await probeExpectedStatus("local auth /api/system/meta", `${base}/api/system/meta`, 200, { attempts: 30, auth });
  await probeExpectedStatus("local /auth/login", `${base}/auth/login`, 200, { attempts: 30 });

  const localLoginResponse = await fetchResponse(`${base}/auth/login`, {
    body: new URLSearchParams({
      password: env.pass,
      username: env.user,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    timeoutMs: 12_000,
  });
  if (localLoginResponse.status !== 200) {
    throw new Error(`local POST /auth/login expected 200, got ${localLoginResponse.status}`);
  }
  const localCookie = localLoginResponse.headers.get("set-cookie") || "";
  if (!localCookie.includes("claude2web_auth=")) {
    throw new Error("local POST /auth/login missing auth cookie");
  }

  if (publicUrl) {
    await probeExpectedStatus("public unauth /", `${publicUrl}/`, 302, { attempts: 12, timeoutMs: 15_000 });
    await probeExpectedStatus("public auth /", `${publicUrl}/`, 200, { attempts: 12, auth, timeoutMs: 15_000 });
    await probeExpectedStatus("public auth /api/system/meta", `${publicUrl}/api/system/meta`, 200, {
      attempts: 12,
      auth,
      timeoutMs: 15_000,
    });
    await probeExpectedStatus("public /auth/login", `${publicUrl}/auth/login`, 200, {
      attempts: 12,
      timeoutMs: 15_000,
    });

    const publicLoginResponse = await fetchResponse(`${publicUrl}/auth/login`, {
      body: new URLSearchParams({
        password: env.pass,
        username: env.user,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      timeoutMs: 15_000,
    });
    if (publicLoginResponse.status !== 200) {
      throw new Error(`public POST /auth/login expected 200, got ${publicLoginResponse.status}`);
    }
    const publicCookie = publicLoginResponse.headers.get("set-cookie") || "";
    if (!publicCookie.includes("claude2web_auth=")) {
      throw new Error("public POST /auth/login missing auth cookie");
    }
    if (!/;\s*Secure\b/i.test(publicCookie)) {
      throw new Error("public POST /auth/login auth cookie must be Secure");
    }
  }
}

function printPortIsolation() {
  const claudeListener = run("lsof", ["-nP", "-iTCP:4522", "-sTCP:LISTEN"], { ignoreFailure: true }).trim();
  const prodListener = run("lsof", ["-nP", "-iTCP:4422", "-sTCP:LISTEN"], { ignoreFailure: true }).trim();
  process.stdout.write(`4522 listening: ${String(Boolean(claudeListener))}\n`);
  process.stdout.write(`4422 listening: ${String(Boolean(prodListener))}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();
  const publicUrl = args["skip-public"] === "true" ? "" : args.url || process.env.CLAUDE2WEB_PUBLIC_URL || DEFAULT_PUBLIC_URL;

  assertLabWorktree(repoRoot);
  await mkdir(RUNTIME_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await readFile(ENV_PATH, "utf-8");

  rsyncRuntime(repoRoot);
  await ensureSymlink(RUNTIME_LINK, RUNTIME_DIR);
  await ensureSymlink(ENV_LINK, ENV_PATH);
  await writeAppPlist();
  await chmod(PLIST_PATH, 0o644);
  restartLaunchAgent();

  const waitMs = Number(args["wait-ms"] || 8000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  await verifyHttp({ publicUrl });
  printPortIsolation();

  process.stdout.write(
    [
      "Claude2Web local deploy complete.",
      `Source: ${repoRoot}`,
      `Runtime: ${RUNTIME_DIR}`,
      `LaunchAgent: ${APP_LABEL}`,
      publicUrl ? `Public URL: ${publicUrl}` : "Public verification skipped.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
});
