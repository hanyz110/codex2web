# P15 - Provider Architecture and Claude Readonly Viewer

## Metadata

- phase_id: `P15`
- title: `Provider Architecture and Claude Readonly Viewer`
- created_at: `2026-04-30T00:00:00+08:00`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`
- worktree: `/Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab`
- branch: `codex/provider-claude`

## Goal

Prove Claude2Web can be built without disrupting the existing production Codex2Web service. This phase introduces a provider boundary and a Claude readonly transcript path while keeping the default browser experience on Codex. The user outcome is simple: the current `codex2web.idea-search.com` service keeps working, and the lab worktree can inspect local Claude sessions safely before any Claude send/resume behavior is attempted.

## Non-Goals

1. Do not modify the active serving worktree at `/Users/honesty/Desktop/SELf/产品开发/codex2web`.
2. Do not restart or repoint the current `codex2web.idea-search.com` launchd service.
3. Do not implement Claude send/resume in this phase.
4. Do not expose Claude provider through the existing production tunnel.
5. Do not rename the product or split a new repository until readonly Claude support passes QA.

## Deliverables

1. Provider interface plan covering `discoverSessions`, `getTranscript`, `sendPrompt`, `stop`, `getExecutionPolicy`, and runtime readiness.
2. `CodexProvider` compatibility path that preserves current Codex session behavior by default.
3. `ClaudeProvider` readonly discovery and transcript parsing for `~/.claude/projects/**/*.jsonl`.
4. UI/provider selection limited to a lab/local environment, with Codex remaining the default provider.
5. QA evidence proving the production worktree and launchd target were not changed.

## Exit Criteria

1. `CODEX2WEB_PROVIDER=codex` keeps the current Codex behavior unchanged in the lab service.
2. `CODEX2WEB_PROVIDER=claude` can list Claude sessions from `~/.claude/projects` and render user/assistant transcript text.
3. Claude provider returns a clear disabled state for send/stop instead of pretending resume is ready.
4. Lab service runs on a separate local port, recommended `4522`, not production `4422`.
5. A QA report records real commands and confirms `/Users/honesty/Desktop/SELf/产品开发/codex2web` was not edited by this phase.

## Closed Loop Gates

- [x] plan
- [ ] review
- [ ] execute
- [ ] qa
- [ ] acceptance

## Plan Notes

Current production service is launchd-backed from `/Users/honesty/Desktop/SELf/产品开发/codex2web`, so active development must happen in `/Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab` on branch `codex/provider-claude`.

Sequence:

1. Freeze production worktree by convention: no P15 edits in the serving directory.
2. Introduce provider modules behind an env flag, defaulting to `codex`.
3. Move existing Codex-specific session discovery and transcript parsing behind `CodexProvider` without behavior changes.
4. Add `ClaudeProvider` readonly parsing for Claude JSONL records:
   - user record: `type=user`, `message.role=user`, string or block content
   - assistant record: `type=assistant`, `message.role=assistant`, `message.content[].type=text`
   - ignore `queue-operation`, `attachment`, `last-prompt` except for metadata if useful
5. Run local lab QA on `127.0.0.1:4522`.
6. Only after readonly acceptance, plan a separate phase for Claude send/resume.

Known risk: local Claude CLI currently returned `API Error: API returned an empty or malformed response (HTTP 200)` against the configured `ANTHROPIC_BASE_URL`. That blocks reliable send/resume QA, but does not block readonly transcript support.

## Review Notes

Review completed in the lab worktree. The provider boundary is intentionally small: the server still talks to a bridge-shaped object with the existing methods, while each provider reports capabilities through `getProviderInfo()`. Codex remains the compatibility path and Claude is a readonly bridge with no send/resume or stop implementation.

Review checklist:

1. Provider interface maps to existing Codex behavior without broad UI rewrites: yes. `LocalSessionBridge` remains the Codex provider and reports send/stop support.
2. Claude parsing handles real local JSONL samples without leaking attachment/tool records into chat: yes. It only renders `type=user|assistant` records with text content.
3. Disabled send/stop is honest: yes. Claude returns `send=disabled`, UI disables the composer, and API send/stop return `PROVIDER_READONLY`.
4. Production isolation is mechanically verified: yes. QA includes worktree and serving-directory checks.

## Execute Notes

Implemented in `/Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab` on branch `codex/provider-claude`.

Changed files:

1. `src/server/local-bridge.js`
   - Added Codex provider metadata while preserving current Codex bridge behavior.
2. `src/server/providers/claude-readonly-bridge.js`
   - Added readonly Claude discovery and transcript parsing for `~/.claude/projects/**/*.jsonl`.
   - Added explicit `PROVIDER_READONLY` errors for send and stop.
3. `src/server/dev-server.js`
   - Added `CODEX2WEB_PROVIDER=codex|claude` selection, defaulting to `codex`.
   - Added provider metadata to `/api/system/meta`.
4. `src/server/public/app.js`
   - Added provider capability awareness.
   - Disabled composer/quick commands in Claude readonly mode.
   - Labels assistant messages with the active provider display name.

## QA Notes

Initial setup QA to run before implementation:

```bash
git worktree list
git -C /Users/honesty/Desktop/SELf/产品开发/codex2web status --short
git -C /Users/honesty/Desktop/SELf/产品开发/codex2web-claude-lab status --short
```

Implementation QA targets:

```bash
CODEX2WEB_PROVIDER=codex PORT=4522 npm run dev
CODEX2WEB_PROVIDER=claude PORT=4522 npm run dev
```

Readonly Claude verification should use real samples from `~/.claude/projects`, not synthetic fixtures only.

Executed QA:

```bash
node --check src/server/dev-server.js
node --check src/server/local-bridge.js
node --check src/server/providers/claude-readonly-bridge.js
node --check src/server/public/app.js
CODEX2WEB_PROVIDER=claude PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS http://127.0.0.1:4522/api/sessions
curl -sS http://127.0.0.1:4522/api/session/binding
curl -sS -X POST http://127.0.0.1:4522/api/session/send -H 'content-type: application/json' -d '{"message":"hello"}'
CODEX2WEB_PROVIDER=codex PORT=4522 npm run dev
curl -sS http://127.0.0.1:4522/api/system/meta
curl -sS http://127.0.0.1:4522/api/session/binding
git worktree list
rg -n "P15|Claude Readonly|provider-claude" /Users/honesty/Desktop/SELf/产品开发/codex2web/spec-kit /Users/honesty/Desktop/SELf/产品开发/codex2web/src 2>/dev/null || true
git status --short
git branch --show-current
```

Observed results:

1. Syntax checks passed.
2. Claude mode started on `127.0.0.1:4522` with `provider=claude`.
3. Claude `/api/sessions` listed 64 real local Claude sessions from `~/.claude/projects`.
4. Claude `/api/session/binding` returned `send=disabled`, provider capabilities `send=false` and `stop=false`, and rendered user/assistant transcript entries from a real JSONL session.
5. Claude `/api/session/send` returned HTTP 501 with `PROVIDER_READONLY`.
6. Codex mode started on `127.0.0.1:4522` with `provider=codex`, `send=true`, and `stop=true`.
7. `git worktree list` showed production serving worktree on `main` and lab worktree on `codex/provider-claude`.
8. Production serving directory search returned no P15/Claude provider hits under `spec-kit` or `src`.

## Acceptance Notes

Acceptance requires a local lab demo and a written statement that production `codex2web.idea-search.com` remains on the original serving worktree and port `4422`.

## Evidence Log

- 2026-04-30T00:00:00+08:00 [plan] P15 created to isolate Claude2Web/provider work in `codex2web-claude-lab` and protect the active Codex2Web service.

- 2026-04-30T15:09:35.626Z [review] Reviewed scope: kept provider boundary bridge-shaped, Codex default preserved, Claude limited to readonly JSONL transcript inspection.
- 2026-04-30T15:09:45.701Z [execute] Implemented CODEX2WEB_PROVIDER selection, Codex provider metadata, Claude readonly JSONL bridge, and UI capability handling in lab worktree only.
- 2026-04-30T15:09:56.660Z [qa] QA passed: syntax checks, Claude provider on 4522 listed 64 real Claude sessions and returned readonly 501 on send, Codex provider on 4522 reported send/stop true, production serving src/spec-kit had no P15 hits.
- 2026-04-30T15:21:00.100Z [acceptance] Accepted after readonly Claude viewer QA and follow-up production-impact check: 4422 still runs from production worktree with auth boundary, 4522 not running, P15 changes isolated to lab branch.