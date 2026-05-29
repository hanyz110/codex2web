# P17 - Claude Runtime Gateway Auth Repair

## Metadata

- phase_id: `P17`
- title: `Claude Runtime Gateway Auth Repair`
- created_at: `2026-04-30`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`
- worktree: `/Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab`
- branch: `codex/provider-claude`

## Goal

Find the root cause of the Claude send blocker from P16 and make the failure reproducible without exposing credentials. The user outcome is a clear diagnosis: whether Claude2Web is blocked by its own provider code, the Claude CLI, or the configured Anthropic gateway/auth environment.

## Non-Goals

1. Do not print or commit API keys, OAuth tokens, auth headers, or full credential-bearing config values.
2. Do not modify the production worktree or production `4422` service.
3. Do not change the user’s real Claude account/login state.
4. Do not guess new gateway URLs or credentials.
5. Do not mark Claude browser send as ready until P16 readiness passes.

## Deliverables

1. Root-cause evidence for the Claude send failure.
2. A reusable redacted diagnostic command for Claude runtime/gateway checks.
3. Updated phase notes explaining the exact blocker and required next action.

## Exit Criteria

1. The diagnostic command reports Claude CLI path/version/auth status without leaking secrets.
2. The diagnostic command can optionally probe `ANTHROPIC_BASE_URL/v1/messages` and report HTTP status/content type/error message.
3. The root cause is localized to a component boundary.
4. Production worktree remains untouched.

## Closed Loop Gates

- [x] plan
- [ ] review
- [ ] execute
- [ ] qa
- [ ] acceptance

## Plan Notes

Use systematic debugging:

1. Reproduce the P16 failure from the CLI.
2. Check Claude CLI binary, version, and auth status.
3. Inspect only config keys and redacted environment metadata.
4. Probe the configured gateway endpoint with a one-token request.
5. Add a reusable diagnostic script so the check can be repeated after credentials or gateway settings are corrected.

## Review Notes

Review decision: do not change credentials or try random endpoint variants. The failure must be attributed to a specific boundary. Evidence points at the Anthropic gateway/auth boundary, not the Claude2Web UI or provider code.

## Execute Notes

Implemented `scripts/claude-runtime-diagnostics.mjs` and `npm run claude:diagnose`.

The script:

1. Reports `which claude`, `claude --version`, and `claude auth status`.
2. Reads `~/.claude/settings.json` only for key names and redacted env metadata.
3. Redacts token/API key values.
4. Skips network POST by default.
5. Runs an optional one-token API probe with `npm run claude:diagnose -- --api-probe`.

Root-cause finding:

1. Claude CLI is installed at `/Users/honesty/.nvm/versions/node/v22.20.0/bin/claude`.
2. Claude CLI version is `2.1.123 (Claude Code)`.
3. `claude auth status` reports logged in via `oauth_token`, `apiProvider=firstParty`.
4. Claude settings/env provide `ANTHROPIC_BASE_URL=https://claudecode.top` and `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY` is unset.
5. Direct API probe to `https://claudecode.top/v1/messages` returns HTTP `401` with `Invalid API key`.
6. Claude CLI send probe returns `API Error: API returned an empty or malformed response (HTTP 200)`, consistent with a gateway/auth mismatch.

Conclusion: Claude2Web is blocked at the configured Anthropic gateway/auth boundary. The current OAuth token is not accepted as a valid key by the configured gateway endpoint, and browser send must remain disabled.

Repair applied:

1. Updated `~/.claude/settings.json` to DeepSeek Anthropic-compatible gateway:
   - `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
   - `ANTHROPIC_AUTH_TOKEN=<DeepSeek API key>`
   - `ANTHROPIC_MODEL=deepseek-v4-pro[1m]`
   - `ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]`
   - `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]`
   - `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash`
   - `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash`
   - `CLAUDE_CODE_EFFORT_LEVEL=max`
2. Updated `~/.zshrc` with the same DeepSeek model env for new interactive shells.
3. Verified direct API probe returns HTTP `200` JSON `message` from `https://api.deepseek.com/anthropic/v1/messages`.
4. Verified Claude CLI returns `DEEPSEEK_CLAUDE_OK` using `deepseek-v4-pro[1m]`.
5. Verified Claude2Web lab readiness reports `sendReady=true`.
6. Verified Claude2Web lab send appends `CLAUDE2WEB_DEEPSEEK_SEND_OK` to the same pinned Claude session.

## QA Notes

Executed:

```bash
node --check scripts/claude-runtime-diagnostics.mjs
node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log("package.json ok")'
npm run claude:diagnose
npm run claude:diagnose -- --api-probe
```

Observed:

1. Script syntax passed.
2. `package.json` remains valid.
3. Default diagnostic run redacts env values and skips the POST probe.
4. `--api-probe` reports:
   - endpoint: `https://claudecode.top/v1/messages`
   - HTTP status: `401`
   - content type: `application/json; charset=utf-8`
   - error message: `Invalid API key`

Repair QA:

```bash
zsh -ic 'cd /Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab && npm run claude:diagnose -- --api-probe'
ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic' ANTHROPIC_AUTH_TOKEN='<redacted>' ANTHROPIC_MODEL='deepseek-v4-pro[1m]' ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-v4-pro[1m]' ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-v4-pro[1m]' ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-v4-flash' CLAUDE_CODE_SUBAGENT_MODEL='deepseek-v4-flash' CLAUDE_CODE_EFFORT_LEVEL='max' claude -p --output-format json --permission-mode bypassPermissions 'Reply exactly: DEEPSEEK_CLAUDE_OK'
zsh -ic 'cd /Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab && CODEX2WEB_PROVIDER=claude CLAUDE2WEB_ENABLE_SEND=true PORT=4522 npm run dev'
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS -X POST http://127.0.0.1:4522/api/session/send -H 'content-type: application/json' -d '{"message":"Reply exactly: CLAUDE2WEB_DEEPSEEK_SEND_OK"}'
curl -sS http://127.0.0.1:4522/api/session/binding
```

Observed repair results:

1. DeepSeek API probe returns HTTP `200`, JSON type `message`, model `deepseek-v4-pro[1m]`.
2. Claude CLI returns `DEEPSEEK_CLAUDE_OK`; model usage reports `deepseek-v4-pro[1m]`.
3. Claude2Web `/api/system/meta` reports provider `sendReady=true`.
4. Claude2Web `/api/session/send` returns HTTP `200`.
5. Claude2Web transcript for pinned session `4ecd30f7-f051-4149-9bed-74ca9f913482` includes assistant text `CLAUDE2WEB_DEEPSEEK_SEND_OK`.

## Acceptance Notes

Accepted as repaired. Claude Code is now configured to DeepSeek V4-pro, the gateway probe passes, Claude CLI responds, and Claude2Web lab send/resume works against the pinned session.

## Evidence Log

- 2026-04-30T00:00:00+08:00 [plan] P17 created to debug the Claude send readiness blocker systematically before attempting any credential or gateway changes.

- 2026-04-30T15:34:16.641Z [plan] P17 plan uses systematic debugging to localize Claude send failure without leaking credentials or touching production.
- 2026-04-30T15:34:16.671Z [review] Reviewed scope: no random endpoint guessing, no credential edits, root cause must be attributed to a component boundary.
- 2026-04-30T15:34:16.703Z [execute] Added npm run claude:diagnose redacted diagnostic script for Claude CLI/auth/base-url and optional API probe.
- 2026-04-30T15:34:16.734Z [qa] QA passed: diagnostic script and package JSON validate; default run redacts secrets; --api-probe shows https://claudecode.top/v1/messages returns HTTP 401 Invalid API key.

- 2026-04-30T15:46:40.473Z [acceptance] Accepted after DeepSeek V4-pro repair: diagnostic API probe returns 200 JSON message, Claude CLI returns DEEPSEEK_CLAUDE_OK using deepseek-v4-pro[1m], and Claude2Web lab send appends CLAUDE2WEB_DEEPSEEK_SEND_OK to the same pinned session.