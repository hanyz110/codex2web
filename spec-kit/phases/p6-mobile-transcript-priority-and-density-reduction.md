# P6 - Mobile Transcript Priority and Density Reduction

## Metadata

- phase_id: `P6`
- title: `Mobile Transcript Priority and Density Reduction`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Reduce mobile chrome so the transcript becomes the dominant visible region. Session truth and drawer access must remain available, but non-essential labels, controls, and persistent surfaces should shrink or disappear unless needed. The mobile first screen should privilege the information stream over session metadata.

## Non-Goals

1. Do not change the real session bridge, transcript source, or send semantics from P5.
2. Do not redesign the desktop hierarchy again in this phase.
3. Do not remove explicit session details or QA controls; they must remain available in the drawer.

## Deliverables

1. A denser mobile session summary that consumes materially less vertical space.
2. A mobile layout where transcript receives more visible height and secondary copy is reduced.
3. Updated spec evidence showing the mobile-first follow-up was planned, reviewed, executed, and QA-checked.

## Exit Criteria

1. Mobile session summary height is materially reduced from the prior P5 state.
2. Mobile transcript receives more visible vertical area and remains in the first-screen task path.
3. Drawer access, pinned session truth, and send path remain functional.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. User feedback identified the remaining defect precisely: mobile information flow was still too small because secondary regions kept consuming space.
2. `ui-ux-pro-max` was re-used to validate a mobile-first direction: compact header, progressive disclosure, and flat touch-first styling.
3. Execution sequence: shrink header -> reduce transcript and composer chrome -> keep secondary controls inside the drawer -> re-measure mobile viewport occupancy.

## Review Notes

1. Review conclusion: treat this as a narrow mobile-density phase rather than reopening P5.
2. The mobile problem was caused by layout priority, not bridge or data issues.
3. Keep session truth visible but compress it to a summary; hide secondary copy and triggers from the main transcript path on mobile.

## Execute Notes

1. Compressed the mobile session summary: smaller heading, inline detail button, lighter metadata line.
2. Hid non-essential transcript/composer explanatory copy on mobile while preserving the desktop version.
3. Reinstated a compact sticky mobile composer so the send control stays reachable without overwhelming the viewport.
4. Expanded transcript height on mobile and removed unnecessary mobile chrome from the first screen.

Changed files:
1. `src/server/public/index.html`
2. `src/server/public/app.css`
3. `src/server/public/app.js`

## QA Notes

1. Mobile Playwright measurements before/after confirmed the session summary dropped from `154px` to `111px` tall.
2. Mobile transcript visible height stabilized at `414px` inside a `390x664` viewport after density reduction.
3. Drawer access remained functional and no runtime errors appeared during Playwright checks.
4. Existing real send path remained intact from P5; this phase did not regress the composer transport.

## Acceptance Notes

Go. P6 is accepted.

Acceptance rationale:
1. The mobile first screen now gives materially more space to the transcript.
2. Non-essential information is either hidden, shortened, or deferred into the drawer.
3. The page still preserves pinned-session truth and explicit secondary controls on demand.

## Evidence Log

- 2026-04-25T01:24:00Z [plan] Created P6 to isolate the remaining mobile density defect after P5 closed.
- 2026-04-25T01:24:00Z [review] Confirmed the issue was layout priority on mobile, not bridge semantics or desktop IA.
- 2026-04-25T01:24:00Z [execute] Compressed the mobile header, reduced explanatory chrome, and expanded transcript priority.
- 2026-04-25T01:24:00Z [qa] Playwright mobile checks showed summary height reduced from 154px to 111px with transcript height at 414px and no runtime errors.
- 2026-04-25T01:24:00Z [acceptance] Accepted: mobile transcript priority improved while drawer-based secondary controls remained available.

- 2026-04-25T01:25:20.166Z [plan] P6 plan locked to one defect: mobile non-core chrome occupied too much space, so transcript priority had to be increased without touching bridge semantics.
- 2026-04-25T01:25:20.194Z [review] P6 review concluded the issue was mobile layout density only; secondary controls stay available in the drawer and desktop is unchanged.
- 2026-04-25T01:25:20.222Z [execute] P6 execute compressed the mobile header, reduced non-essential copy, and rebalanced sticky composer and transcript height.
- 2026-04-25T01:25:20.250Z [qa] P6 QA passed: Playwright measured mobile summary height down from 154px to 111px, transcript visible height at 414px, with no runtime errors.
- 2026-04-25T01:25:20.277Z [acceptance] Accepted: mobile transcript priority improved and non-core regions are now reduced or deferred into the drawer.