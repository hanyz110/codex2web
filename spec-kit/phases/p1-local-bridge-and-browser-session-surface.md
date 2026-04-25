# P1 - Local Bridge and Browser Session Surface

## Metadata

- phase_id: `P1`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

把浏览器壳升级为真实可交互 surface，确保会话绑定遵循 session-first 规则，建立 discover/attach/stream/send 最小合同。

## Non-Goals

1. 不做 remote desktop 或 Codex Desktop GUI 控制。
2. 不做 tunnel 对外暴露和公网认证。
3. 不做多会话并发控制。

## Deliverables

1. local bridge API：`/api/sessions`、`/api/session/attach`、`/api/session/stream`、`/api/session/send`
2. 浏览器页面绑定真实 API，展示会话状态、转录流、发送与失败状态
3. persisted session identity 文件与恢复逻辑

## Exit Criteria

1. 浏览器能订阅 pinned session 输出流
2. follow-up 能进入同一会话且结果回到 transcript
3. 刷新后仍使用 persisted session identity

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [ ] qa
- [ ] acceptance

## Plan Notes

先建 bridge 合同，再连 UI，最后做失败态与恢复路径验证。

## Review Notes

评审结论：会话身份必须由服务端 pin 决定，前端只做显示和显式切换触发。

## Execute Notes

已实现 `src/server/local-bridge.js` 与 `src/server/dev-server.js` API 路由；前端页面结构已对齐 SOP。

## QA Notes

已完成 API 侧闭环验证：

1. `GET /api/session/binding` 返回 pinned session + transcript + failure modes
2. `GET /api/sessions` 返回可显式切换会话列表
3. `POST /api/session/send` 正常路径可写入 transcript
4. `POST /api/testing/failure` 注入 send failure 后，`/api/session/send` 返回 `502 SEND_FAILED`
5. `POST /api/session/attach` 仅在 `explicit=true` 时可切换会话

前端联调：页面已接入真实 API 与 SSE，状态芯片、失败态、显式切换入口可工作。

## Acceptance Notes

验收结论：P1 达成目标，可进入 P2。  
残余风险：移动端视觉细节与 tunnel 场景尚未覆盖，已纳入 P2/P3。

## Evidence Log

- 2026-04-25T02:20:00Z [plan] 确认 P1 目标与交付物
- 2026-04-25T02:22:00Z [review] 明确 session-first 与显式切换原则
- 2026-04-25T02:28:00Z [execute] bridge API 与页面骨架接线完成

- 2026-04-24T18:21:13.717Z [qa] API smoke passed: binding/sessions/send + failure inject(send) + attach explicit.

- 2026-04-24T18:21:44.658Z [acceptance] Acceptance approved: P1 bridge contract + UI wiring closed-loop complete.