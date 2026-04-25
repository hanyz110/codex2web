# Codex2Web Design Source Of Truth

## Scope

This file defines the product design rules for the browser chat surface after P4. It does not change bridge semantics, session truth, or SOP rules. It controls how the real-session product is presented and how interaction priority is expressed.

## Product Principles

1. Chat first. The default screen must feel like a conversation surface, not a diagnostics console.
2. Session first. The current pinned session remains the product truth source and must stay visible.
3. Explicit, never implicit. Session switching and failures stay explicit; they are not hidden by visual polish.
4. Mobile first. The mobile layout is the baseline, not a stacked desktop fallback.
5. Calm, technical, precise. Visual language should feel like a reliable local developer tool, not a marketing landing page.

## Design Inputs

This design direction uses `ui-ux-pro-max` as the source exploration tool and keeps only the recommendations that match the product:

1. Keep: flat, content-first, low-decoration, touch-safe layout guidance.
2. Keep: white/gray surfaces with blue accent tokens.
3. Keep: modern sans typography with high clarity.
4. Reject: neumorphism.
5. Reject: dark-only system recommendations.
6. Reject: green CTA emphasis as the primary brand signal.

## Visual Direction

### Tone

- clean
- quiet
- precise
- trustworthy
- developer-tool

### Color Tokens

| Token | Value | Use |
|---|---|---|
| `--bg-page` | `#F8FAFC` | app background |
| `--bg-surface` | `#FFFFFF` | cards, transcript, drawer |
| `--bg-muted` | `#EEF2F7` | secondary strips, chips, muted blocks |
| `--border` | `#D9E2EC` | dividers and control outlines |
| `--text` | `#0F172A` | primary text |
| `--text-muted` | `#5B6B7F` | secondary text |
| `--primary` | `#2563EB` | primary CTA and active state |
| `--primary-hover` | `#1D4ED8` | CTA hover / active |
| `--primary-soft` | `#DBEAFE` | selected chips / soft highlights |
| `--danger` | `#DC2626` | destructive and failure state |
| `--warning` | `#B7791F` | caution / reconnecting state |
| `--success` | `#0F766E` | non-primary success confirmation |
| `--ring` | `rgba(37, 99, 235, 0.22)` | focus ring |

### Typography

- Heading: `Plus Jakarta Sans`
- Body: `Plus Jakarta Sans`
- Body base size: `16px`
- Body line-height: `1.5`
- Title weight range: `600-700`
- Body weight range: `400-500`

### Surface Rules

1. Prefer subtle borders over heavy shadows.
2. Use one elevation family only.
3. Rounded corners should stay in the `12-20px` range.
4. Blue is for focus, primary action, and active context only.
5. Status colors must not become the dominant page aesthetic.

## Information Architecture

### Default Page Structure

1. `Session Bar`
2. `Transcript`
3. `Composer`
4. `Secondary Drawer / Side Panel`

### Session Bar

Must contain:

1. current session name
2. short project label
3. connection state chip
4. entry point to session details

Must not contain:

1. large hero copy
2. expanded UUID wall by default
3. multi-card state dashboard

### Transcript

Rules:

1. This is the dominant visual region.
2. Message content is prioritized over metadata.
3. Role labels and timestamps should be visually weak.
4. Layout should support future markdown and code block rendering.
5. Long histories must have a clear strategy for “jump to latest”, folding, or virtualization.

### Composer

Rules:

1. Composer is the persistent primary control.
2. Show current session targeting near the input, not in a separate dashboard.
3. Send state, retry state, and disabled state must be readable without leaving the composer region.
4. Only one primary CTA: send.

### Secondary Drawer / Panel

Move these out of the default chat column:

1. explicit session switching
2. switch audit
3. auth boundary
4. session technical details
5. QA tools

## QA And Failure Visibility

Failures must stay explicit, but they should be expressed in product form:

1. active failure alerts live near the transcript/composer path
2. failure injection controls live in a QA-only panel
3. auth boundary details live in session details, not in the main reading path

## Responsive Rules

### Mobile

The mobile baseline is:

1. compact session bar at top
2. transcript in the middle
3. sticky composer at bottom
4. drawer or bottom sheet for secondary controls

Mobile must not:

1. render the transcript as an endless document before controls
2. push session controls below massive chat history
3. require horizontal scanning between main task and state task

### Desktop

Desktop may add:

1. wider transcript
2. collapsible side panel
3. session detail panel

Desktop must not:

1. restore the current dashboard-like right rail as a permanent dominant column
2. put the composer in a way that visually overlaps transcript content without clear separation

## Interaction Rules

1. Hover and focus are subtle and fast: `150-220ms`.
2. Press feedback may use slight opacity or translate changes; avoid jumpy scale-heavy motion.
3. Reduced motion must be respected.
4. All interactive controls remain keyboard reachable.
5. Touch targets remain at least `44x44`.

## Implementation Guardrails

1. No new session heuristics.
2. No bridge rewrite inside this design phase unless review explicitly requires it.
3. No decorative marketing hero.
4. No theme direction drift away from white/gray/blue.
5. No production-default exposure of QA controls in the main chat path.

## Review Checklist

Before execute gate:

1. Is the default first impression chat-first?
2. Is session truth still explicit?
3. Are failures still explicit without dominating the main path?
4. Is mobile the baseline rather than a fallback?
5. Are the design tokens internally consistent?
