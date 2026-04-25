# Design System Master File

> Read page overrides in `design-system/codex2web/pages/[page-name].md` first.
> If a page override exists, it wins. Otherwise use this file.

---

**Project:** Codex2Web
**Generated:** 2026-04-25 09:21:00
**Category:** Local AI Chat / Developer Tool

## Global Rules

### Design Direction

- style: flat, content-first, minimal
- mood: precise, calm, trustworthy, technical
- primary model: white and gray surfaces with restrained blue accents
- forbidden: neumorphism, dark-only design, marketing-hero dominance

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#2563EB` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#EAF1FB` | `--color-secondary` |
| On Secondary | `#1E293B` | `--color-on-secondary` |
| Accent | `#DBEAFE` | `--color-accent` |
| Background | `#F8FAFC` | `--color-background` |
| Surface | `#FFFFFF` | `--color-surface` |
| Foreground | `#0F172A` | `--color-foreground` |
| Muted | `#EEF2F7` | `--color-muted` |
| Muted Foreground | `#5B6B7F` | `--color-muted-foreground` |
| Border | `#D9E2EC` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| Ring | `#2563EB` | `--color-ring` |

**Color Notes:** white/gray base, trust-blue accent, technical calm over decorative warmth.

### Typography

- **Heading Font:** Plus Jakarta Sans
- **Body Font:** Plus Jakarta Sans
- **Mood:** modern, neutral, professional, highly readable
- **Google Fonts:** [Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
```

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` | tight spacing |
| `--space-sm` | `8px` | inline spacing |
| `--space-md` | `16px` | control padding |
| `--space-lg` | `24px` | section padding |
| `--space-xl` | `32px` | large section spacing |
| `--space-2xl` | `48px` | page section gaps |

### Elevation

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(15, 23, 42, 0.04)` | small controls |
| `--shadow-md` | `0 10px 30px rgba(15, 23, 42, 0.06)` | floating surfaces |

## Component Specs

### Buttons

```css
.btn-primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
  border-radius: 999px;
  min-height: 44px;
  padding: 0 18px;
  font-weight: 600;
  transition: background-color 180ms ease, transform 180ms ease;
}

.btn-primary:hover {
  background: #1D4ED8;
}

.btn-secondary {
  background: var(--color-surface);
  color: var(--color-foreground);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  min-height: 44px;
  padding: 0 16px;
}
```

### Surfaces

```css
.surface {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 18px;
  box-shadow: var(--shadow-sm);
}
```

### Inputs

```css
.input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  min-height: 44px;
  padding: 12px 14px;
  font-size: 16px;
}

.input:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
  border-color: var(--color-primary);
}
```

## Style Guidelines

### Hierarchy

1. Session identity is visible but compressed.
2. Transcript owns the page.
3. Composer is the only dominant action area.
4. QA and diagnostics are secondary utilities.

### Responsive Pattern

1. Mobile baseline: session bar -> transcript -> sticky composer.
2. Desktop enhancement: optional secondary panel, never a dominant diagnostics wall.
3. Secondary information must be collapsible or drawer-based.

## Anti-Patterns

- ❌ hero-first layout
- ❌ state dashboard before transcript
- ❌ green primary CTA
- ❌ dark-only styling
- ❌ QA controls in the default main path
- ❌ content-heavy right rail dominating the first screen

## Pre-Delivery Checklist

- [ ] White/gray/blue palette remains consistent
- [ ] Primary action is visually singular
- [ ] Transcript is the dominant visual region
- [ ] Mobile path keeps composer accessible
- [ ] Explicit session switching remains visible but secondary
- [ ] Failures are explicit without becoming the page headline
- [ ] Focus states and reduced-motion support remain intact
