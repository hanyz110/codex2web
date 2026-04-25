# Phone Browser QA Checklist

Scope: iOS Safari + Android Chrome through tunnel entry.

## Preconditions

1. tunnel URL is active
2. external auth boundary is enabled
3. test account has valid basic auth credentials

## Core Path

1. open tunnel URL on phone
2. pass basic auth prompt
3. open session drawer and confirm `execution` is visible
4. confirm status chips show `connected` + `attached` + `streaming`
5. send one follow-up message
6. confirm transcript appends user message (and assistant response when available)

## Failure Path

1. tap `触发连接失败`
2. confirm send button becomes blocked
3. confirm alert message appears

## Recovery Path

1. tap `重连演示`
2. confirm status recovers to `connected/streaming`
3. confirm alert changes to recovery state

## Explicit Switch Path

1. tap `刷新候选会话`
2. choose a candidate via `切换` button
3. confirm session id changes in `Session Pin`
4. confirm `Switch Audit` records `session_switch`

## Responsive/Usability Checks

1. transcript is above the fold on 375px width
2. no horizontal scroll
3. touch targets are reachable and not blocked by browser chrome
4. theme toggle works on mobile

## Pass Criteria

1. all four flows (core/failure/recovery/switch) pass on both iOS and Android
2. no silent session switching observed
3. auth prompt appears consistently for fresh browser sessions
4. external path does not regress into dangerous execution profile
