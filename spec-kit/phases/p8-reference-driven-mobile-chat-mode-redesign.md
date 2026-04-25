# P8 - Reference-Driven Mobile Chat Mode Redesign

## Metadata

- phase_id: `P8`
- title: `Reference-Driven Mobile Chat Mode Redesign`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Reshape the mobile experience to feel like a real chat app, using the provided reference as the interaction benchmark. On phones, the interface should prioritize a compact app-bar header, an immersive transcript stream, and a floating bottom composer, while keeping non-core controls deferred into the drawer and preserving the same pinned-session semantics underneath.

## Non-Goals

1. Do not change desktop information architecture beyond any small compatibility adjustments needed to support the mobile markup.
2. Do not alter the local session bridge, auth boundary, explicit switching rules, or transport semantics.
3. Do not add new product capabilities such as search, attachments, or voice input; this phase is presentation and interaction-priority work only.

## Deliverables

1. A mobile app-bar header that replaces the oversized card-like session summary with a compact top strip and drawer entry.
2. A transcript-first mobile layout with softer, full-width chat flow styling inspired by the reference and reduced persistent chrome.
3. A bottom floating composer that visually matches chat-app expectations while still sending follow-up messages through the existing path.

## Exit Criteria

1. On mobile widths, header chrome is substantially reduced and no longer dominates the first screen.
2. The transcript occupies the majority of visible vertical space, with message styling closer to mainstream AI chat/mobile messenger products.
3. Drawer access, pinned-session truth, transcript rendering, and send flow all remain functional after the redesign.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. The reference image makes the design defect concrete: the current mobile UI still feels like stacked desktop cards rather than a phone-native chat screen.
2. `ui-ux-pro-max` guidance for this phase: content-priority on mobile, progressive disclosure for secondary controls, 44px+ touch targets, and predictable chat-style navigation/composer patterns.
3. Planned sequence:
   - compress the top region into an app-bar pattern
   - flatten the transcript surface so the message stream becomes the visual focus
   - restyle the composer as a floating mobile control bar
   - keep secondary controls in the drawer and preserve current JS behavior

## Review Notes

1. Review conclusion: this should be a new phase, not a late edit to P7, because the work is a mobile IA and visual-language shift rather than transcript rendering.
2. The reference should be treated as structural guidance, not copied literally; the product still needs explicit drawer access and pinned-session identity.
3. Keep the write scope focused on `index.html`, `app.css`, and any minimal `app.js` tweaks needed to support new labels or controls.

## Execute Notes

1. Reworked the top mobile region into an app-bar pattern with a circular drawer trigger, smaller session title stack, muted subtitle, and compact connection pill.
2. Flattened the mobile transcript shell so the feed dominates the screen, added avatar-based message rows, softened bubble styling, and removed card-heavy section chrome.
3. Rebuilt the composer into a floating bottom input bar with a drawer-triggering plus action, auto-growing textarea, and circular send button.
4. Fixed two mobile interaction regressions found during QA:
   - drawer close button pointer-hit instability inside the drawer header
   - transcript horizontal overflow that pushed the floating latest button outside the visible viewport

Changed files:
1. `src/server/public/index.html`
2. `src/server/public/app.css`
3. `src/server/public/app.js`

## QA Notes

1. `curl -I http://127.0.0.1:4321/` returned `HTTP/1.1 200 OK`.
2. `node --check src/server/public/app.js` passed after the JS changes.
3. Mobile Playwright checks verified:
   - header height reduced to `87px`
   - transcript visible height reached `478px`
   - composer starts at `78px` and auto-grows to `160px`
   - page horizontal overflow was eliminated (`scrollWidth = clientWidth = 390`)
4. Mobile interaction QA verified:
   - drawer open/close works from the mobile app-bar trigger and close button
   - `jump-to-latest` becomes visible after scrolling to older messages and hides again after activation
   - no runtime errors appeared during mobile checks
5. Evidence screenshots were captured at `/tmp/p8-mobile.png`, `/tmp/p8-mobile-viewport.png`, and `/tmp/p8-mobile-final.png`.

## Acceptance Notes

Go. P8 is accepted.

Acceptance rationale:
1. Mobile now reads as a transcript-first chat screen instead of stacked desktop cards.
2. Non-core controls are deferred into the drawer while the header and composer stay compact.
3. The redesign preserved pinned-session truth, transcript rendering, and follow-up input semantics.

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T01:36:19.783Z [plan] P8 plan locked to the user-provided mobile reference: compact app bar, transcript-first stream, and floating composer with no bridge changes.
- 2026-04-25T01:36:19.810Z [review] P8 review approved a new mobile-only redesign phase rather than reopening P7; scope stays in public UI files and preserves drawer-based secondary controls.

- 2026-04-25T01:56:24.382Z [execute] P8 execute shipped the mobile app-bar header, transcript-first message layout, floating composer, and QA-driven fixes for drawer close hit area and transcript overflow.
- 2026-04-25T01:56:24.408Z [qa] P8 QA passed: mobile Playwright confirmed header 87px, transcript 478px, composer 78px->160px auto-grow, drawer close button works, jump-to-latest recovers correctly, and horizontal overflow was removed (390/390).
- 2026-04-25T01:56:24.434Z [acceptance] Accepted: the mobile UI now matches the requested chat-app direction while preserving pinned-session truth and existing follow-up semantics.