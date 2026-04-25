# P4 - Real Codex Session Bridge and Chat-First UI

## Metadata

- phase_id: `P4`
- title: `Real Codex Session Bridge and Chat-First UI`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Replace the mock bridge and console-style shell with a real local Codex session surface. The browser must discover the true project session from `~/.codex`, render the actual human chat transcript, send follow-up instructions back into the same session, and present the UI in a chat-first structure that matches the PRD rather than a diagnostic demo panel.

## Non-Goals

1. Do not control the Codex Desktop window or attempt remote-desktop behavior.
2. Do not invent a new hidden replacement session when the pinned session is missing.
3. Do not expand into multi-project heuristics or tunnel deployment work in this phase.

## Deliverables

1. Real local session bridge backed by `~/.codex/session_index.jsonl` and `~/.codex/sessions/**/*.jsonl`.
2. Real follow-up transport implemented through `codex exec resume <session>`.
3. Chat-first browser UI that renders actual session identity, transcript, send state, and audit context.

## Exit Criteria

1. `/api/sessions` and `/api/session/binding` return the actual local Codex session for the current project.
2. Browser send reaches the same pinned session and the assistant reply returns into transcript.
3. In-app browser QA confirms the page is visually chat-first, hydrated with real data, and free of console warnings/errors.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. Use session identity, not project-name guessing, as the browser truth source.
2. Prefer `event_msg.user_message` and `event_msg.agent_message` as transcript input to avoid tool noise.
3. Sequence: real session discovery -> real send transport -> chat-first UI rewrite -> localhost QA -> phase close.

## Review Notes

1. Reviewed against SOP hard rules: session-first, no silent rebinding, failures explicit.
2. Reviewed against PRD complaint from the user: current shell was not real chat mode and not a real Codex stream.
3. Decision: stop iterating on mock transcript logic and move the bridge to file-backed real session parsing first.

## Execute Notes

1. Replaced the mock `local-bridge` with a real bridge that scans local Codex sessions, normalizes human transcript events, polls for appended output, and persists the pinned session identity.
2. Implemented real send transport through `codex exec resume` and exposed runtime send state back to the UI.
3. Reworked the browser page into a chat-first surface while keeping audit/failure/auth panels as secondary rails.

Changed files:
1. `src/server/local-bridge.js`
2. `src/server/dev-server.js`
3. `src/server/public/index.html`
4. `src/server/public/app.css`
5. `src/server/public/app.js`
6. `docs/execution-plan.md`

## QA Notes

1. `node --check src/server/dev-server.js && node --check src/server/local-bridge.js && node --check src/server/public/app.js`
2. `curl http://127.0.0.1:4321/api/sessions` returned the real session `019dc0a9-c0e1-7cd2-93af-41904e69c174`.
3. `curl http://127.0.0.1:4321/api/session/binding` returned the actual session metadata and real transcript history.
4. `POST /api/session/send` with `只回复 WEB_REAL_SEND_OK` appended both the user message and assistant reply into the same session transcript.
5. In-app browser QA confirmed hydrated session state, chat transcript rendering, composer submission, send-state transitions, and final reply `BROWSER_UI_SEND_OK`.

## Acceptance Notes

Go. P4 satisfies the current SOP target that the browser surface is operating a real local Codex session rather than a mock bridge shell.

Follow-ups:
1. Add transcript virtualization or folding once the chat history grows larger.
2. Consider a dedicated unread/new-message affordance for long-running sessions.

## Evidence Log

- 2026-04-25T00:30:40Z [plan] Locked P4 scope to real session discovery, real send transport, and chat-first browser UI.
- 2026-04-25T00:31:52Z [review] Rejected further mock-shell polishing after validating `codex exec resume` works for the same session.
- 2026-04-25T00:41:21Z [execute] Real bridge, real send transport, and chat-first UI landed in server and browser files.
- 2026-04-25T00:44:34Z [qa] API verification and in-app browser send-flow QA passed with real transcript replies.
- 2026-04-25T00:44:34Z [acceptance] Accepted: browser is now backed by a real Codex session and matches the intended chat-first operating model.

- 2026-04-25T00:45:50.187Z [plan] Scope locked to real Codex session discovery, real send transport, and chat-first UI.
- 2026-04-25T00:45:50.225Z [review] Reviewed against SOP/PRD and chose to replace the mock shell with a real adapter.
- 2026-04-25T00:45:50.259Z [execute] Real bridge, real send transport, and chat-first browser UI implemented.
- 2026-04-25T00:45:50.292Z [qa] API curl checks and in-app browser composer/send verification passed with real replies.
- 2026-04-25T00:45:50.337Z [acceptance] Accepted: browser surface now operates a real local Codex session.