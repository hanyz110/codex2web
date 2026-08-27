import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_SERVER_FORK_TIMEOUT_MS = 8000;
const MAX_APP_SERVER_ERROR_CHARS = 2000;

export function isThreadActiveWriterConflict(value) {
  const text = String(value || "");
  return /thread-store conflict:[\s\S]*already has an active writer/i.test(text) ||
    /thread\/resume[\s\S]*already has an active writer/i.test(text);
}

export function isThreadWriterLockHeld(
  threadId,
  { fileExists = existsSync, homeDir = os.homedir(), runProcess = spawnSync } = {},
) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(normalizedThreadId)) {
    return false;
  }
  const lockPath = path.join(homeDir, ".codex", "thread-writer-locks", `${normalizedThreadId}.lock`);
  if (!fileExists(lockPath)) {
    return false;
  }
  const result = runProcess("lsof", ["-t", lockPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

function forkExecutionConfig(executionPolicy) {
  const cliArgs = Array.isArray(executionPolicy?.cliArgs) ? executionPolicy.cliArgs : [];
  if (cliArgs.includes("--dangerously-bypass-approvals-and-sandbox")) {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
  }
  if (cliArgs.includes("--full-auto")) {
    return {
      approvalPolicy: "never",
      sandbox: "workspace-write",
    };
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
}

export function forkCodexThread({
  codexBinaryPath,
  executionPolicy,
  session,
  spawnProcess = spawn,
  timeoutMs = APP_SERVER_FORK_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      codexBinaryPath,
      ["app-server", "--listen", "stdio://"],
      {
        cwd: session.projectPath,
        env: {
          ...process.env,
          TERM: process.env.TERM || "xterm-256color",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let settled = false;
    let pendingResult = null;
    let shutdownTimeoutId = null;
    let stderrText = "";
    let stdoutRemainder = "";

    const requestShutdown = () => {
      clearTimeout(timeoutId);
      child.stdin.end();
      if (child.exitCode != null) {
        finish(null, pendingResult);
        return;
      }
      child.kill("SIGTERM");
      shutdownTimeoutId = setTimeout(() => {
        finish(new Error("Codex app-server 已创建 Web 续接会话，但未能及时释放写入锁。"));
      }, 2000);
      shutdownTimeoutId.unref?.();
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      clearTimeout(shutdownTimeoutId);
      try {
        child.stdin.end();
      } catch {
        // The app-server may already have closed stdin after returning a response.
      }
      if (child.exitCode == null) {
        child.kill("SIGTERM");
      }
    };

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timeoutId = setTimeout(() => {
      finish(new Error("Codex app-server 创建 Web 续接会话超时。"));
    }, timeoutMs);
    timeoutId.unref?.();

    child.on("error", (error) => {
      finish(new Error(`Codex app-server 启动失败：${String(error.message || error)}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (pendingResult) {
        finish(null, pendingResult);
        return;
      }
      const detail = stderrText.trim();
      finish(new Error(detail || `Codex app-server 提前退出（退出码 ${String(code)}）。`));
    });

    child.stderr.on("data", (chunk) => {
      stderrText = `${stderrText}${chunk.toString("utf-8")}`.slice(-MAX_APP_SERVER_ERROR_CHARS);
    });

    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk.toString("utf-8");
      const lines = stdoutRemainder.split("\n");
      stdoutRemainder = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        if (response?.id === 3 && pendingResult) {
          requestShutdown();
          return;
        }
        if (response?.id !== 2) {
          continue;
        }
        if (response.error) {
          finish(new Error(response.error.message || "Codex app-server 无法创建 Web 续接会话。"));
          return;
        }
        const forkSessionId = String(response.result?.thread?.id || "").trim();
        if (!forkSessionId) {
          finish(new Error("Codex app-server 返回的 Web 续接会话缺少 ID。"));
          return;
        }
        pendingResult = {
          filePath: String(response.result?.thread?.path || "").trim(),
          sessionId: forkSessionId,
        };
        const sourceName = String(session.name || "").trim();
        if (sourceName) {
          child.stdin.write(`${JSON.stringify({
            id: 3,
            method: "thread/name/set",
            params: {
              name: `${sourceName}（Web续接）`,
              threadId: forkSessionId,
            },
          })}\n`);
        } else {
          requestShutdown();
        }
        return;
      }
    });

    const forkConfig = forkExecutionConfig(executionPolicy);
    const requests = [
      {
        id: 1,
        method: "initialize",
        params: {
          capabilities: { experimentalApi: true },
          clientInfo: {
            name: "codex2web",
            title: "Codex2Web",
            version: "0.0.1",
          },
        },
      },
      { method: "initialized", params: {} },
      {
        id: 2,
        method: "thread/fork",
        params: {
          ...forkConfig,
          cwd: session.projectPath,
          deferGoalContinuation: true,
          excludeTurns: true,
          runtimeWorkspaceRoots: [session.projectPath],
          threadId: session.id,
        },
      },
    ];

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}
