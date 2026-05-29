# P16 - Claude Send Resume Readiness and Minimal Interactive Path

## Metadata

- phase_id: `P16`
- title: `Claude Send Resume Readiness and Minimal Interactive Path`
- created_at: `2026-04-30`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`
- worktree: `/Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab`
- branch: `codex/provider-claude`

## Goal

Move Claude2Web from readonly inspection toward a real interactive path without weakening the session continuity rules. The user outcome is that the lab service can tell whether local Claude send/resume is actually usable, expose that readiness honestly in the browser, and only enable Claude sending when a real CLI probe proves the transport works.

## Non-Goals

1. Do not modify the production serving worktree at `/Users/honesty/Desktop/SELf/产品开发/codex2web`.
2. Do not expose Claude mode through `codex2web.idea-search.com` or production port `4422`.
3. Do not remove Codex as the default provider.
4. Do not silently create replacement Claude sessions when resume fails.
5. Do not mark Claude send/resume supported if the local Claude CLI still returns malformed/empty API responses.
6. Do not implement broad multi-agent abstractions beyond the provider boundary needed for Claude.

## Deliverables

1. Claude runtime readiness probe covering binary discovery, version/help availability, session files, and a real send/resume dry-run strategy.
2. Claude provider state that distinguishes `readonly`, `send-unavailable`, `send-ready`, `sending`, and `failed` without ambiguous UI states.
3. Minimal Claude send/resume implementation behind readiness gating, using the pinned session only.
4. Browser UI that shows the exact blocker when Claude sending is unavailable.
5. QA evidence for both paths:
   - unavailable transport remains readonly and explicit
   - if transport is available, send appends to the same pinned Claude session

## Exit Criteria

1. `CODEX2WEB_PROVIDER=claude PORT=4522 npm run dev` still lists and renders existing Claude transcripts.
2. `/api/system/meta` and `/api/session/binding` report Claude send readiness and the reason for disabled send when blocked.
3. When readiness fails, browser send remains disabled and API send returns a clear provider/runtime error.
4. When readiness passes, browser send targets the pinned Claude session and refresh/snapshot shows new transcript output from the same session id.
5. `CODEX2WEB_PROVIDER=codex` still preserves Codex behavior in the lab.
6. Production worktree and `4422` service remain unchanged.

## Closed Loop Gates

- [x] plan
- [ ] review
- [ ] execute
- [ ] qa
- [ ] acceptance

## Plan Notes

Sequence:

1. Inspect installed Claude CLI commands and local session file format before changing send code.
2. Define a small readiness object on the Claude provider:
   - `runtimeReady`
   - `sendReady`
   - `reason`
   - `checkedAt`
   - `binaryPath`
3. Add API/UI plumbing for readiness without enabling send yet.
4. Implement the minimal send path only if the CLI provides a reliable resume/continue command for an existing session id.
5. If the local CLI still fails with `API returned an empty or malformed response (HTTP 200)`, stop at a gated unavailable state and record the blocker.
6. Run QA on port `4522` only.

Known risk from P15: local Claude CLI produced `API Error: API returned an empty or malformed response (HTTP 200)` against the configured API gateway. That blocks honest send/resume acceptance until the runtime is fixed or the command path is proven with another configuration.

## Review Notes

Review completed. The phase must not enable Claude send from the browser unless a real CLI probe proves the transport works. If the local Claude runtime keeps returning malformed API responses, the correct product behavior is a clear blocked readonly state.

Review checklist:

1. Preserves pinned session continuity: yes. User sends only target `claude --resume <pinnedSessionId>`; no fork or silent replacement session is used.
2. Failure stays explicit: yes. Failed readiness returns `PROVIDER_RUNTIME_NOT_READY` and keeps send disabled.
3. UI is honest when send is blocked: yes. Provider readiness reason is surfaced through metadata and composer disabled state.
4. Production isolation remains required: yes. QA repeats production worktree and `4422` checks.

## Execute Notes

Implemented in the lab worktree only.

Changed files:

1. `src/server/providers/claude-readonly-bridge.js`
   - Added Claude CLI version/runtime probe.
   - Added optional real send probe behind `CLAUDE2WEB_ENABLE_SEND=true`.
   - Added readiness metadata to provider capabilities.
   - Added gated `sendInput()` using `claude -p --output-format stream-json --resume <pinnedSessionId>`.
   - Added `stopInput()` for an active Claude send process.
   - Keeps send disabled unless the real probe passes.
2. `src/server/dev-server.js`
   - Passes `CODEX2WEB_CLAUDE_BINARY` / `CLAUDE2WEB_CLAUDE_BINARY`.
   - Passes `CLAUDE2WEB_ENABLE_SEND=true` into the Claude provider.
3. `src/server/public/app.js`
   - Shows provider readiness blockers in the disabled-send feedback path.
   - Uses a readiness-specific placeholder for the disabled composer.

Runtime finding: Claude CLI is installed and reports `2.1.123 (Claude Code)`, but the real send probe fails with `API Error: API returned an empty or malformed response (HTTP 200)`. Therefore the implementation correctly remains in blocked readonly mode on this machine.

## QA Notes

Planned checks:

```bash
which claude || true
claude --version || true
claude --help || true
CODEX2WEB_PROVIDER=claude PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS http://127.0.0.1:4522/api/session/binding
curl -sS -X POST http://127.0.0.1:4522/api/session/send -H 'content-type: application/json' -d '{"message":"Claude2Web readiness probe"}'
CODEX2WEB_PROVIDER=codex PORT=4522 npm run dev
git -C /Users/honesty/Desktop/SELf/产品开发/codex2web status --short --untracked-files=all
lsof -nP -iTCP:4422 -sTCP:LISTEN
lsof -nP -iTCP:4522 -sTCP:LISTEN || true
```

Executed QA:

```bash
which claude || true
claude --version || true
claude --help || true
claude resume --help || true
node --check src/server/providers/claude-readonly-bridge.js
node --check src/server/dev-server.js
node --check src/server/public/app.js
CODEX2WEB_PROVIDER=claude PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS -X POST http://127.0.0.1:4522/api/session/send -H 'content-type: application/json' -d '{"message":"hello"}'
CODEX2WEB_PROVIDER=claude CLAUDE2WEB_ENABLE_SEND=true PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS http://127.0.0.1:4522/api/session/binding
curl -sS -X POST http://127.0.0.1:4522/api/session/send -H 'content-type: application/json' -d '{"message":"hello"}'
CODEX2WEB_PROVIDER=codex PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS http://127.0.0.1:4522/api/session/binding
git -C /Users/honesty/Desktop/SELf/产品开发/codex2web status --short --untracked-files=all
lsof -nP -iTCP:4422 -sTCP:LISTEN || true
```

Observed results:

1. Claude CLI exists at `/Users/honesty/.nvm/versions/node/v22.20.0/bin/claude`.
2. Claude CLI version is `2.1.123 (Claude Code)`.
3. Syntax checks passed.
4. Default Claude mode reports `runtimeReady=true`, `sendReady=false`, reason: send disabled until `CLAUDE2WEB_ENABLE_SEND=true`.
5. Default Claude send returns HTTP 503 with `PROVIDER_READONLY`.
6. Explicit send-probe mode reports `runtimeReady=true`, `sendReady=false`, reason: `API Error: API returned an empty or malformed response (HTTP 200)`.
7. Explicit send-probe mode send returns HTTP 503 with `PROVIDER_RUNTIME_NOT_READY`.
8. Codex provider still reports `send=true`, `stop=true`, and `mode=interactive`.
9. Production worktree status is empty.
10. Production service remains listening on `4422`.

## Acceptance Notes

Acceptance requires either:

1. Claude send/resume proven against a real pinned session, or
2. a clear blocked-state implementation with evidence that the local Claude runtime is not currently capable of reliable send/resume.

Originally accepted under path 2 because the previous gateway rejected the configured credential. After P17 moved Claude Code to DeepSeek V4-pro, P16 was re-run under path 1:

1. `CODEX2WEB_PROVIDER=claude CLAUDE2WEB_ENABLE_SEND=true PORT=4522 npm run dev`
2. `/api/system/meta` reported `sendReady=true`.
3. `/api/session/send` accepted a prompt for pinned session `4ecd30f7-f051-4149-9bed-74ca9f913482`.
4. `/api/session/binding` showed the same session appended `CLAUDE2WEB_DEEPSEEK_SEND_OK`.

Claude send/resume is now proven in the lab worktree with DeepSeek V4-pro.

## Evidence Log

- 2026-04-30T00:00:00+08:00 [plan] P16 created after P15 readonly acceptance to move toward Claude interactivity without pretending send/resume is ready.

- 2026-04-30T15:21:40.700Z [plan] P16 plan defines readiness-first Claude send/resume path, keeps production isolated, and forbids silent replacement sessions.
- 2026-04-30T15:22:44.696Z [review] Reviewed P16 scope: readiness must gate Claude send; no silent session creation for user sends; production 4422 stays out of scope; default Codex provider unchanged.

- 2026-04-30T15:29:38.840Z [execute] Implemented Claude runtime readiness metadata, optional real send probe behind CLAUDE2WEB_ENABLE_SEND=true, gated pinned-session resume send, and blocked-state UI feedback.
- 2026-04-30T15:29:38.868Z [qa] QA passed for blocked-state path: Claude CLI 2.1.123 found, default send returns PROVIDER_READONLY, enabled probe reproduces malformed HTTP 200 API error and returns PROVIDER_RUNTIME_NOT_READY; Codex provider still reports send/stop true; production 4422 unchanged.
- 2026-04-30T15:29:38.903Z [acceptance] Accepted under blocked-state criterion: Claude2Web now exposes readiness blocker instead of enabling unreliable send; next phase should fix Claude API/gateway/auth runtime.
