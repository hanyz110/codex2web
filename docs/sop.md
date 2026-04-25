# Codex2Web SOP

## Objective

Build an independent browser product for operating a local Codex session.

Do not treat OpenClaw product pages as the shipping surface.

## Hard Rules

1. session-first, not window-first
2. project context belongs to the session
3. no silent creation of replacement sessions
4. no "latest active" rebinding
5. failures must be explicit

## V1 Operating Model

1. one browser page binds to one local persistent session
2. refresh restores that same session
3. only explicit user action may switch to another session

## Phase Closure Standard

Every phase must complete a closed loop:

1. plan
2. review
3. implement
4. real simulated QA
5. acceptance

A phase is not complete if any step is missing.

## QA Gates

1. live stream visible
2. same session continues across sends
3. refresh restores the same session
4. send failures are visible
5. connection failures are visible
6. session switching is explicit only

## Forbidden Regressions

1. binding by Desktop GUI window
2. binding by project name alone
3. binding by latest timestamp alone
4. opening a fresh hidden session and pretending it is continuity
