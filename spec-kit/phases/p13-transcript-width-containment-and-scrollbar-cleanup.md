# P13 - Transcript Width Containment and Scrollbar Cleanup

## Metadata

- phase_id: `P13`
- title: `Transcript Width Containment and Scrollbar Cleanup`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Ensure transcript content always stays visually contained within the browser viewport, even for long links and long code tokens, while removing the visible scrollbars that currently make the chat surface feel rough. Users should still be able to scroll transcript and code content, but without message bubbles or scroll tracks breaking the layout.

## Non-Goals

1. Do not change transcript rendering semantics, session logic, or external access behavior.
2. Do not remove the ability to horizontally inspect code blocks if overflow is needed for edge cases.
3. Do not redesign the broader chat layout in this phase.

## Deliverables

1. CSS containment fixes for long transcript content, especially code blocks and long URLs.
2. Hidden scrollbar styling for the main transcript and other user-facing scroll regions.
3. QA evidence showing no width overflow in representative long-content scenarios on mobile and desktop.

## Exit Criteria

1. Long message content no longer expands transcript width beyond the viewport.
2. Transcript remains scrollable while visible scrollbars are hidden.
3. Desktop and mobile checks pass without introducing layout regressions.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. User feedback identified two concrete polish defects: content occasionally appears to exceed browser width, and visible scrollbars degrade the chat feel.
2. `ui-ux-pro-max` guidance applied here: contain content priority on mobile, prevent horizontal layout breakage, and keep chrome visually quiet without removing touch/scroll affordances.
3. Planned sequence:
   - reproduce overflow with long URL / long code token content
   - constrain width at transcript/code container boundaries
   - hide scrollbars for transcript and code regions
   - run mobile/desktop regression checks

## Review Notes

1. Review conclusion: this is a focused containment and polish phase, not a new content feature.
2. Root cause is layout-level, not transcript parsing: long code blocks can expand internal scroll width far beyond the transcript client width.
3. Decision: preserve code scrolling capability but hide tracks and keep all scrollable regions clipped inside the chat surface.

## Execute Notes

1. Updated `/src/server/public/app.css` only.
2. Added width containment safeguards across `message-row`, `message-content`, `message-body`, `code-block`, and `code-block pre` so long code tokens cannot expand the transcript internals beyond the visible container.
3. Added hidden-scrollbar styling for `transcript-list`, `code-block pre`, and `session-drawer` while preserving scroll interaction.
4. Kept horizontal code inspection behavior intact by allowing `pre` to remain scrollable and moving the overflow cost inside the code surface instead of the transcript layout.

## QA Notes

1. Verified local server responds on `http://127.0.0.1:4321/`.
2. Re-ran the real overflow repro on mobile (`iPhone 12`) and desktop (`1440x1200`) by injecting a long URL plus a long code token into the transcript.
3. Mobile result after fix:
   - `documentScrollWidth=390`, `documentClientWidth=390`
   - `transcriptScrollWidth=354`, `transcriptClientWidth=354`
   - `preScrollWidth=3053`, `preClientWidth=228`
   - `scrollbarWidth=none`, `::-webkit-scrollbar display=none`
4. Desktop result after fix:
   - `documentScrollWidth=1440`, `documentClientWidth=1440`
   - `transcriptScrollWidth=882`, `transcriptClientWidth=882`
   - `preScrollWidth=307`, `preClientWidth=307`
   - `scrollbarWidth=none`, `::-webkit-scrollbar display=none`
5. Captured screenshots for visual inspection:
   - `/tmp/p13-mobile-after.png`
   - `/tmp/p13-desktop-after.png`

## Acceptance Notes

1. Go: the chat surface no longer shows transcript-width expansion under the reproduced long-token case.
2. Go: visible scrollbar tracks are hidden for the main transcript, code surfaces, and session drawer, while scroll remains functional.
3. Follow-up stays outside this phase: broader remote-phone access remains under `P11`, and in-flight stop/cancel remains under `P12`.

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T03:39:55.085Z [plan] P13 scope defined around transcript width containment, hidden scrollbars, and mobile/desktop verification without touching session semantics.
- 2026-04-25T03:40:12.824Z [review] Review confirmed the bug is layout-level: long code tokens expanded pre width inside the transcript. Fix scoped to CSS containment plus visual scrollbar cleanup.
- 2026-04-25T03:40:12.870Z [execute] Implemented containment and scrollbar cleanup in src/server/public/app.css by constraining message and code surfaces to max-width 100% and hiding transcript/code/drawer scrollbars.
- 2026-04-25T03:40:12.908Z [qa] Local QA passed on http://127.0.0.1:4321 with mobile and desktop Playwright repro. After fix transcriptScrollWidth matched transcriptClientWidth and scrollbar styles resolved to none.
- 2026-04-25T03:40:12.951Z [acceptance] Accepted: transcript content stays within viewport under reproduced long-token cases, and visible scroll tracks are removed without disabling scrolling.