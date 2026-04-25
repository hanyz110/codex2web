# Browser Shell Override

Page: `browser-shell`
Updated: 2026-04-25

## Overrides On Top Of MASTER

1. Keep **both light and dark** themes enabled.
2. Use heading/body pairing:
   - Heading: `Space Grotesk`
   - Body: `IBM Plex Sans`
3. Preserve SOP status clarity:
   - required state chips: `connection`, `attach`, `stream`, `send`
4. Put transcript panel before all secondary cards on mobile to keep live output above the fold.
5. Keep explicit controls visible:
   - reconnect button
   - explicit switch session button
   - failure-state simulation entrypoints for QA

## Forbidden Regressions On This Page

1. No silent session switch.
2. No hidden error state.
3. No UI path that implies "latest session auto-selected".
