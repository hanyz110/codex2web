# P9 - Transcript Link and Code Action Enhancements

## Metadata

- phase_id: `P9`
- title: `Transcript Link and Code Action Enhancements`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Improve transcript usability so users can immediately act on message content. Links in assistant/user messages should be clickable and safe, while fenced code blocks should provide an obvious copy action. The result should feel closer to mainstream AI chat tools without changing pinned-session behavior or transport semantics.

## Non-Goals

1. Do not change the bridge APIs, session attachment logic, or stream semantics.
2. Do not introduce full Markdown engines or server-side content rendering in this phase.
3. Do not redesign the global layout; this phase is scoped to transcript content actions.

## Deliverables

1. Safe clickable link rendering for Markdown links and plain `http/https` URLs in transcript text.
2. Code block header copy action with feedback state (`复制` -> `已复制`) for quick reuse.
3. QA evidence for desktop/mobile behavior with no runtime regressions.

## Exit Criteria

1. Transcript messages containing links render usable anchor elements and do not break existing inline formatting.
2. Code blocks expose a working copy action that can be triggered from the transcript UI.
3. Core chat path (send, stream updates, jump-to-latest, drawer controls) remains functional after changes.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. The current transcript already supports list/code formatting, but lacks direct actions on message content, causing avoidable copy friction.
2. `ui-ux-pro-max` constraints used here: maintain touch-accessible controls (>=44px), keep visual hierarchy lightweight, and preserve existing mobile-first content priority.
3. Sequence:
   - add safe link rendering in inline formatter
   - add copy action controls for fenced code blocks
   - style action controls across desktop/mobile without disturbing existing shells
   - run QA on rendering + interactions + regression paths

## Review Notes

1. Review approved a narrow content-action phase with no bridge/data contract changes.
2. Security boundary for links: only explicit `http/https` URLs should be linkified.
3. Implementation decision: use event delegation on transcript list for copy buttons to avoid per-message listeners and re-render leaks.

## Execute Notes

1. Upgraded inline formatter to support:
   - Markdown links: `[label](https://...)`
   - Plain URLs: `https://...`
   - tokenized replacement flow to avoid linkifying URLs inside inline code.
2. Enhanced fenced code block rendering to include a header action button (`复制`) in each block.
3. Added transcript-level event delegation for `.code-copy-button` with clipboard API + fallback copy path and transient success feedback (`已复制`).
4. Added styles for actionable content:
   - `.inline-link` desktop/mobile contrast and hover states
   - `.code-copy-button` base/hover/success states with touch-friendly mobile size.

Changed files:
1. `src/server/public/app.js`
2. `src/server/public/app.css`

## QA Notes

1. `node --check src/server/public/app.js` passed.
2. Source-level assertion checks validated key paths:
   - linkification regex and token flow present in `formatInlineMarkdown`
   - copy button markup present in `renderMessageHtml`
   - transcript event delegation for `.code-copy-button` present.
3. VM-based function checks using live source snippets validated behavior:
   - `[OpenAI](https://openai.com)` and `https://example.com` produce anchor output
   - URL inside inline code remains plain code, not linkified
   - fenced code block output includes `.code-copy-button`.
4. Runtime browser QA was blocked in this environment: local `dev-server` listen failed with `EPERM` on both `127.0.0.1:4321` and `0.0.0.0:5678` due sandbox networking restrictions.

## Acceptance Notes

Go (conditional). P9 is accepted with one environment caveat.

Acceptance rationale:
1. Content-action features are fully implemented and verified through syntax + source-driven functional checks.
2. Scope remains aligned with P9 constraints and does not alter bridge/session semantics.
3. Outstanding caveat: manual in-browser interaction verification is still recommended in a host environment where local port binding is permitted.

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T02:53:36.620Z [plan] P9 plan locked to transcript content actions: safe link rendering and code copy controls without bridge/API changes.
- 2026-04-25T02:53:36.648Z [review] P9 review approved client-side formatter and transcript-level event delegation for copy actions with strict http/https link scope.

- 2026-04-25T02:58:58.545Z [execute] P9 execute shipped safe link rendering, code-block copy action, clipboard fallback, and transcript-level copy event delegation in app.js/app.css.
- 2026-04-25T02:58:58.573Z [qa] P9 QA passed static and VM checks (linkify behavior, no linkify inside inline code, code copy button rendered). Runtime browser QA was sandbox-blocked by listen EPERM when starting dev-server.
- 2026-04-25T02:58:58.601Z [acceptance] Accepted conditionally: implementation and functional checks complete, with one documented caveat that host-side browser interaction should be manually confirmed outside sandbox networking limits.