# Chat Surface Page Overrides

> These rules override `design-system/codex2web/MASTER.md` for the main chat page.

---

## Layout Overrides

- **Primary Layout:** transcript-centered chat surface
- **Desktop Structure:** main chat column + collapsible secondary side panel
- **Mobile Structure:** top session bar + transcript + sticky composer + bottom sheet / drawer for secondary controls
- **Max Width:** transcript column should stay readable; target `760-920px` effective reading width on desktop

## Content Priority

Order of importance:

1. current conversation
2. next input
3. current session identity
4. secondary controls
5. technical diagnostics

## Session Bar Rules

Show:

1. session name
2. short project label
3. connection chip
4. details trigger

Hide by default:

1. full project path
2. full session id wall
3. multi-card connection dashboard

## Transcript Rules

1. Role and timestamp are low-emphasis metadata.
2. Message body spacing should support prose and code-oriented content.
3. Empty state should explain the value and next action, not just say there is no content.
4. Long transcripts should prepare for future fold/virtualization patterns.

## Composer Rules

1. Composer is sticky and always reachable.
2. Send state messaging sits inside the composer region.
3. Primary CTA stays blue.
4. Secondary actions near composer must stay minimal.

## Secondary Panel Rules

Allowed in drawer/panel only:

1. explicit switch list
2. switch audit
3. auth boundary
4. QA controls
5. detailed session metadata

## Explicit Avoid Rules

- Avoid warm beige / brown page atmospherics
- Avoid large hero banner copy
- Avoid stacked diagnostic cards above transcript
- Avoid pushing drawer content inline below transcript on mobile
