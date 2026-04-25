# Codex2Web Execution Plan (Spec Kit Driven)

## Closed Loop Rule

Every phase must pass this exact loop:

1. `plan`
2. `review`
3. `execute`
4. `qa`
5. `acceptance`

Gate order is enforced by `spec-kit`:

```bash
node scripts/spec-kit.mjs status
node scripts/spec-kit.mjs autoplan
```

## Phase Map

| Phase | Workstream Mapping | Current Status | Spec |
|---|---|---|---|
| P1 | Workstream 1 + 2 (Local bridge + Browser UI) | closed | `spec-kit/phases/p1-local-bridge-and-browser-session-surface.md` |
| P2 | Workstream 3 (Session restore and selection) | closed | `spec-kit/phases/p2-session-restore-and-explicit-selection-hardening.md` |
| P3 | Workstream 4 (External access) | closed | `spec-kit/phases/p3-external-access-and-auth-boundary.md` |
| P4 | Real local session bridge + chat-first UI retrofit | closed | `spec-kit/phases/p4-real-codex-session-bridge-and-chat-first-ui.md` |
| P5 | Chat-first UX simplification + mobile-first session surface | closed | `spec-kit/phases/p5-chat-surface-ux-simplification-and-mobile-first-session-experience.md` |
| P6 | Mobile transcript priority + density reduction | closed | `spec-kit/phases/p6-mobile-transcript-priority-and-density-reduction.md` |
| P7 | Transcript content rendering + latest-message navigation | closed | `spec-kit/phases/p7-transcript-content-rendering-and-latest-message-navigation.md` |
| P8 | Reference-driven mobile chat mode redesign | closed | `spec-kit/phases/p8-reference-driven-mobile-chat-mode-redesign.md` |
| P9 | Transcript link + code action enhancements | closed | `spec-kit/phases/p9-transcript-link-and-code-action-enhancements.md` |
| P10 | Multi-project session discovery + explicit switching | closed | `spec-kit/phases/p10-multi-project-session-discovery-and-explicit-switching.md` |
| P11 | External tunnel launch + remote phone access verification | closed | `spec-kit/phases/p11-external-tunnel-launch-and-remote-phone-access-verification.md` |
| P12 | In-flight turn stop + execution cancellation | ready_to_close | `spec-kit/phases/p12-in-flight-turn-stop-and-execution-cancellation.md` |
| P13 | Transcript width containment + scrollbar cleanup | closed | `spec-kit/phases/p13-transcript-width-containment-and-scrollbar-cleanup.md` |
| P14 | Browser execution permission parity + trust boundary | closed | `spec-kit/phases/p14-browser-execution-permission-parity-and-trust-boundary.md` |

## P1 Exit Criteria

1. browser can subscribe to one pinned session
2. follow-up input reaches that same session
3. refresh/reconnect restores by persisted session identity
4. explicit connection/session/send failures are visible in UI

## P2 Exit Criteria

1. explicit session switching UX is deterministic and safe
2. browser never silently switches to latest session
3. restore and attach failure paths are fully covered by QA

## P3 Exit Criteria

1. same browser entry is tunnel-ready without changing session semantics
2. auth boundary is explicit and testable
3. phone browser QA checklist is complete

## Immediate Next Action

`P12` 已完成 `plan/review/execute/qa/acceptance`，当前状态为 `ready_to_close`。当前执行顺序：

1. 在可监听端口环境补一轮浏览器端 E2E（发送中停止、空闲停止、停止后继续发送）
2. 确认 E2E 证据后关闭 `P12` phase
3. 基于新基线评估下一阶段交互与外网运维增强项
