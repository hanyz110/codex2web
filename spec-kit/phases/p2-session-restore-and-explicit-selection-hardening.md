# P2 - Session Restore and Explicit Selection Hardening

## Metadata

- phase_id: `P2`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

强化会话恢复与选择机制，保证 refresh/reconnect 始终回到同一 identity，并禁止任何 silent switch。

## Non-Goals

1. 不扩展到外网访问。
2. 不引入多设备并发同步。

## Deliverables

1. restore/reconnect 规则与异常分支补齐
2. 显式选择会话流程（可用性与可见性）
3. 切换审计记录与防误切换保护

## Exit Criteria

1. reconnect 后 identity 一致
2. 无自动切换到“最新会话”
3. 会话切换必须用户显式确认

## Closed Loop Gates

- [ ] plan
- [ ] review
- [ ] execute
- [ ] qa
- [ ] acceptance

## Plan Notes

计划范围：

1. 把会话切换从 `prompt` 升级为可见列表，避免误选和无效输入。
2. 增加 session 切换审计日志（who/when/from/to/reason）。
3. 为 reconnect 增加明确恢复反馈，区分“恢复成功”和“仍在重连”。
4. 把失败态触发从调试入口收敛到统一调试面板，便于 QA 执行脚本化验证。

## Review Notes

评审结论（P2 开始前）：

1. 当前显式切换依赖 `window.prompt`，可用性差且不利于移动端。
2. 当前不存在持久审计记录，只能通过 transcript 间接追踪。
3. reconnect 的状态显示依赖事件流错误回调，缺少显式“恢复成功”视觉锚点。
4. 现有 API 合同已满足 P2 基础，不需要新增核心接口，可在现有合同上加固。

## Execute Notes

已完成执行项：

1. 显式切换从 `window.prompt` 改为候选会话列表按钮，避免隐式输入风险。
2. 新增 `GET /api/session/audit`，并在 `attach`/`restore` 写入审计事件。
3. 前端新增 `Switch Audit` 区块，实时展示切换轨迹。
4. 重连恢复增加“连接已恢复”反馈，避免用户误判状态。

## QA Notes

已执行闭环 QA：

1. 核心主路径：`sessions -> attach(explicit) -> send` 全部通过。
2. 失败路径：注入 `connection=true` 后，`/api/session/send` 返回 `503 CONNECTION_DOWN`。
3. 恢复路径：`/api/testing/reset` 后再次 `send` 成功。
4. 审计路径：`/api/session/audit` 可看到 `session_restore` 与 `session_switch` 事件。
5. UI 标记验证：页面存在 `sessionCandidates` 与 `auditList` 区块。

## Acceptance Notes

验收结论：P2 达成目标，允许进入 P3。  
说明：P2 聚焦 local-first 语义与显式切换硬化，外网与认证边界留在 P3。

## Evidence Log

- 2026-04-25T02:30:00Z [plan] created
- 2026-04-25T02:36:00Z [plan] P2 scope, deliverables, and exit criteria detailed
- 2026-04-25T02:38:00Z [review] current-state review completed with hardening backlog
- 2026-04-25T02:44:00Z [execute] session candidate list + audit trail API/UI implemented
- 2026-04-25T02:46:00Z [qa] core/failure/recovery/audit path checks passed

- 2026-04-24T18:22:21.083Z [plan] P2 plan completed: restore UX, explicit selection hardening, switch audit trail.
- 2026-04-24T18:22:21.116Z [review] P2 review completed: prompt-based switching, missing audit, reconnect feedback gaps identified.

- 2026-04-24T18:26:04.143Z [execute] Executed: candidate list switch UX + session audit API/UI + reconnect recovery feedback.

- 2026-04-24T18:26:41.950Z [qa] QA passed: core/failure/recovery + audit API + UI markers validated.
- 2026-04-24T18:26:49.362Z [qa] QA passed: core/failure/recovery + audit API + UI markers validated.
- 2026-04-24T18:26:49.391Z [acceptance] Acceptance approved: session restore and explicit selection hardening complete.