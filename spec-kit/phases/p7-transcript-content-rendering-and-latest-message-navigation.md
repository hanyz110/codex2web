# P7 - Transcript Content Rendering and Latest-Message Navigation

## Metadata

- phase_id: `P7`
- title: `Transcript Content Rendering and Latest-Message Navigation`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Make the transcript behave like a real AI chat surface instead of a plain text log. Users should be able to read numbered lists, bullet lists, quotes, inline code, and fenced code blocks with clear hierarchy, while retaining control when they scroll away from the latest message. New messages should no longer yank the viewport when the user is reading history.

## Non-Goals

1. Do not change the local bridge, session pinning semantics, or transport contract.
2. Do not redesign the overall mobile layout again; this phase is about transcript content rendering and latest-message navigation only.
3. Do not introduce full Markdown parsing, rich text editing, or server-side content transformations.

## Deliverables

1. Transcript rendering that formats common chat content patterns: paragraphs, ordered lists, unordered lists, quotes, inline code, and fenced code blocks.
2. A `jump to latest` affordance that appears only when the user is reading older messages and disappears after returning to the live bottom.
3. QA evidence proving the renderer works with a real transcript example and that no runtime errors were introduced on desktop or mobile.

## Exit Criteria

1. Transcript messages with common Markdown-like patterns are visually structured instead of shown as undifferentiated plain text.
2. When the user scrolls upward, new messages no longer forcibly snap the transcript to the bottom, and a visible recovery control returns them to the latest message.
3. Desktop and mobile verification pass without runtime errors, and the pinned-session send flow remains intact.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. User feedback showed the UI still felt unlike a mainstream AI chat product because transcript content had weak hierarchy and no explicit latest-message recovery.
2. `ui-ux-pro-max` guidance used in this phase emphasized readable content hierarchy, code treatment, and preserving scroll agency on mobile-first chat interfaces.
3. Execution sequence: add transcript rendering helpers -> style rich content blocks -> add latest-message control and scroll stickiness rules -> validate with a real Markdown/code-block transcript example.

## Review Notes

1. Review conclusion: keep scope narrow and avoid reopening layout work from P6.
2. The product gap was in content readability and scroll behavior, not in bridge correctness or session state management.
3. Use a lightweight client-side formatter instead of a heavy Markdown library to reduce risk and keep the current static browser surface simple.

## Execute Notes

1. Added transcript content rendering helpers in `app.js` for paragraphs, ordered/unordered lists, blockquotes, inline code, and fenced code blocks.
2. Updated transcript rendering to inject structured HTML for message bodies while preserving escaped content safety.
3. Added a floating `jump to latest` button plus scroll state logic so the transcript only auto-sticks when the user remains near the bottom.
4. Added transcript content styles in `app.css` for rich message content and the new floating recovery control.

Changed files:
1. `src/server/public/index.html`
2. `src/server/public/app.css`
3. `src/server/public/app.js`

## QA Notes

1. `node --check src/server/public/app.js` passed, confirming the new renderer and scroll logic are syntactically valid.
2. Real transcript QA used the prompt `请只回复以下 markdown，保持原样： ...` and the assistant returned a numbered list plus fenced `js` code block, which rendered correctly in the transcript.
3. Playwright desktop and mobile checks completed without runtime errors; screenshots were captured at `/tmp/p7-desktop.png`, `/tmp/p7-mobile.png`, and refreshed evidence at `/tmp/p7-desktop-latest.png`, `/tmp/p7-mobile-latest.png`.
4. Local access check returned `HTTP/1.1 200 OK` from `http://127.0.0.1:4321/`, confirming the current page remained reachable during QA.

## Acceptance Notes

Go. P7 is accepted.

Acceptance rationale:
1. Transcript content now reads like a chat product rather than a raw log.
2. The user can inspect older messages without losing position, then recover to the live bottom explicitly.
3. The phase improved readability and control without touching the pinned-session bridge contract.

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T01:35:13.926Z [plan] P7 plan locked: improve transcript content hierarchy and latest-message recovery without touching bridge semantics.
- 2026-04-25T01:35:13.954Z [review] P7 review approved narrow scope: client-side formatting plus jump-to-latest, no layout-phase reopening.
- 2026-04-25T01:35:13.982Z [execute] P7 execute shipped renderer helpers, code block styling, and jump-to-latest behavior in public app files.
- 2026-04-25T01:35:14.010Z [qa] P7 QA passed: node --check ok, local page returned HTTP 200, real markdown/code-block transcript rendered, screenshots captured at /tmp/p7-desktop*.png and /tmp/p7-mobile*.png.
- 2026-04-25T01:35:14.039Z [acceptance] Accepted: transcript now reads like chat content and preserves scroll control while keeping pinned-session semantics unchanged.