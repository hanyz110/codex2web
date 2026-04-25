# Codex2Web PRD

## Product Statement

Codex2Web is an independent browser product for operating a local Codex session.

It does not modify or proxy the OpenClaw product UI.

## Primary Goal

Allow the user to open a browser page and continue the same local Codex session in real time.

The session must keep its local project context.

## Core User Outcome

The user can:

1. see live Codex output
2. send the next instruction into the same session
3. keep working inside the same local project context
4. understand which execution mode the browser is using before sending a prompt
5. later access the same browser entry from a phone through a tunnel

## Non-Goals

1. controlling the current Codex Desktop GUI window
2. screen streaming or remote desktop
3. creating a new session on every browser request
4. choosing sessions by window title or "latest project" heuristics
5. making Feishu the primary V1 product entry

## V1 Scope

1. local bridge process that talks to local Codex
2. browser page for a single pinned session
3. live transcript stream
4. follow-up input box
5. explicit connection, session, and send-error states
6. explicit browser execution profile with local-vs-external trust boundary

## Product Truth Source

The browser binds to a local persistent session.

Project context is an attribute of that session, not the truth source used to guess which session to attach to.

## V1 Success Criteria

1. browser shows live session output
2. browser sends follow-up input into the same session
3. refresh and reconnect restore the same session
4. the UI clearly shows which session is bound and what local project it belongs to
5. the UI clearly shows which browser execution mode is active
6. no Desktop GUI window recognition is required

## V2 Direction

1. explicit multi-session selection
2. explicit multi-project session list
3. tunnel-based external access from phone
4. optional Feishu integration onto the same session model
