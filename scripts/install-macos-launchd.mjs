#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const APP_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "codex2web");
const APP_SUPPORT_EXTERNAL_DIR = path.join(APP_SUPPORT_DIR, "external");
const APP_SUPPORT_RUNTIME_DIR = path.join(APP_SUPPORT_DIR, "runtime");
const APP_LOG_DIR = path.join(os.homedir(), "Library", "Logs", "codex2web");

const DEFAULT_LABEL = "com.codex2web.external";
const DEFAULT_HOSTNAME = "codex2web.idea-search.com";
const DEFAULT_PORT = "4422";
const DEFAULT_TUNNEL_ID = "da1e0fbb-39ec-49f2-a66c-ce3caed9778f";
const DEFAULT_TUNNEL_NAME = "codex2web";
const DEFAULT_CREDENTIALS_FILE = "/Users/honesty/.cloudflared/da1e0fbb-39ec-49f2-a66c-ce3caed9778f.json";

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

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function runLaunchctl(args, options = {}) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf-8", stdio: options.stdio || "pipe" });
  } catch (error) {
    if (options.ignoreFailure) {
      return "";
    }
    throw error;
  }
}

async function writeEnvFile(envPath, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`);
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, `${lines.join("\n")}\n`, "utf-8");
  await chmod(envPath, 0o600);
}

async function writePlist(plistPath, { command, label, logDir }) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
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
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, "external-launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, "external-launchd.err.log"))}</string>
</dict>
</plist>
`;
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, "utf-8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commandName = args._[0] || "install";
  const label = args.label || DEFAULT_LABEL;
  const uid = process.getuid?.() || Number(execFileSync("id", ["-u"], { encoding: "utf-8" }).trim());
  const launchDomain = `gui/${uid}`;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

  if (commandName === "uninstall") {
    runLaunchctl(["bootout", launchDomain, plistPath], { ignoreFailure: true });
    process.stdout.write(`Uninstalled ${label}\n`);
    return;
  }

  if (commandName === "status") {
    process.stdout.write(runLaunchctl(["print", `${launchDomain}/${label}`], { ignoreFailure: true }) || `${label} is not loaded\n`);
    return;
  }

  if (commandName !== "install") {
    throw new Error(`Unknown command: ${commandName}`);
  }

  const repoRoot = process.cwd();
  const stateDir = APP_SUPPORT_EXTERNAL_DIR;
  const runtimeDir = APP_SUPPORT_RUNTIME_DIR;
  const logDir = APP_LOG_DIR;
  const envPath = path.join(stateDir, "launchd.env");
  const hostname = args.hostname || process.env.CODEX2WEB_CLOUDFLARE_HOSTNAME || DEFAULT_HOSTNAME;
  const port = args.port || process.env.CODEX2WEB_EXTERNAL_PORT || DEFAULT_PORT;
  const user = args.user || process.env.CODEX2WEB_BASIC_USER || "codex2web";
  const pass = args.pass || process.env.CODEX2WEB_BASIC_PASS;
  const tunnelId = args["tunnel-id"] || process.env.CODEX2WEB_CLOUDFLARE_TUNNEL_ID || DEFAULT_TUNNEL_ID;
  const tunnelName = args["tunnel-name"] || process.env.CODEX2WEB_CLOUDFLARE_TUNNEL_NAME || DEFAULT_TUNNEL_NAME;
  const credentialsFile = args["credentials-file"] || process.env.CODEX2WEB_CLOUDFLARE_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;

  if (!pass) {
    throw new Error("Missing --pass or CODEX2WEB_BASIC_PASS for launchd installation.");
  }

  await mkdir(logDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeEnvFile(envPath, {
    CODEX2WEB_BASIC_PASS: pass,
    CODEX2WEB_BASIC_USER: user,
    CODEX2WEB_CLOUDFLARE_CREDENTIALS_FILE: credentialsFile,
    CODEX2WEB_CLOUDFLARE_CONFIG_FILE: path.join(runtimeDir, `cloudflared-${tunnelName || tunnelId}.yml`),
    CODEX2WEB_CLOUDFLARE_HOSTNAME: hostname,
    CODEX2WEB_CLOUDFLARE_TUNNEL_ID: tunnelId,
    CODEX2WEB_CLOUDFLARE_TUNNEL_NAME: tunnelName,
    CODEX2WEB_EXTERNAL_PORT: port,
    CODEX2WEB_PUBLIC_URL: `https://${hostname}`,
  });

  const launchCommand = [
    `cd ${shellQuote(repoRoot)}`,
    `set -a`,
    `source ${shellQuote(envPath)}`,
    `set +a`,
    `exec npm run external:trusted -- --port "$CODEX2WEB_EXTERNAL_PORT" --provider cloudflared --tunnel-id "$CODEX2WEB_CLOUDFLARE_TUNNEL_ID" --tunnel-name "$CODEX2WEB_CLOUDFLARE_TUNNEL_NAME" --hostname "$CODEX2WEB_CLOUDFLARE_HOSTNAME" --credentials-file "$CODEX2WEB_CLOUDFLARE_CREDENTIALS_FILE"`,
  ].join(" && ");

  await writePlist(plistPath, { command: launchCommand, label, logDir });
  runLaunchctl(["bootout", launchDomain, plistPath], { ignoreFailure: true });
  runLaunchctl(["bootstrap", launchDomain, plistPath]);
  runLaunchctl(["enable", `${launchDomain}/${label}`], { ignoreFailure: true });
  runLaunchctl(["kickstart", "-k", `${launchDomain}/${label}`]);

  process.stdout.write(
    [
      `Installed ${label}`,
      `Plist: ${plistPath}`,
      `Env: ${envPath}`,
      `Runtime: ${runtimeDir}`,
      `URL: https://${hostname}`,
      `Logs: ${logDir}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error.message || error)}\n`);
  process.exit(1);
});
