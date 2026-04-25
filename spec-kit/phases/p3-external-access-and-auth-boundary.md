# P3 - External Access and Auth Boundary

## Metadata

- phase_id: `P3`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

在不改变 session 语义的前提下，为 tunnel 对外访问准备认证边界和手机端 QA 基线。

## Non-Goals

1. 不改动本地 session 绑定逻辑。
2. 不重构 bridge 的核心协议。

## Deliverables

1. tunnel-ready 部署说明
2. auth boundary 方案
3. phone browser QA checklist

## Exit Criteria

1. 外网入口复用同一浏览器 surface
2. 认证边界明确且可验证
3. 手机端核心流程可通过 QA

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

计划范围：

1. 提供 tunnel-ready 启动说明（本地端口、暴露方式、风险提示）。
2. 建立最小认证边界（access token 或 basic auth）与失败提示语义。
3. 输出 phone QA 清单，覆盖 iOS/Android 浏览器入口与核心交互。

## Review Notes

评审结论（P3 开始前）：

1. 当前服务仅监听 `127.0.0.1`，默认安全，但外网暴露后无认证保护。
2. 现有 API 可直接复用，不需改变 session 语义。
3. tunnel 场景的主要风险在认证与 replay，不在本地 bridge 协议本身。

## Execute Notes

已完成执行项：

1. 新增外网模式硬约束：`external mode` 且未配置凭证时，服务拒绝启动。
2. 新增全路由 Basic Auth 边界（含静态页、API、SSE）。
3. 新增 `/api/system/meta`，用于前端显示当前安全模式。
4. 前端新增 `Auth Boundary` 区块展示 `mode` 与 `auth` 状态。
5. 新增交付文档：
   - `docs/tunnel-ready.md`
   - `docs/phone-qa-checklist.md`

## QA Notes

已完成 P3 QA：

1. `HOST=0.0.0.0` + `CODEX2WEB_EXTERNAL=true` 且无凭证时，服务退出并提示认证缺失。
2. 配置 `CODEX2WEB_BASIC_USER/PASS` 后，未授权访问 `/` 与 `/api/system/meta` 均返回 `401`。
3. 授权访问 `/api/system/meta` 返回 `authMode=basic`。
4. 本地模式 (`127.0.0.1`) 下默认可用，`authMode=none`。
5. 页面包含 `Auth Boundary` 区块，满足边界可见性要求。

## Acceptance Notes

验收结论：P3 达成目标，且未改变 session-first 语义。  
项目阶段验收：P1-P3 已全部闭环完成。

## Evidence Log

- 2026-04-25T02:30:00Z [plan] created
- 2026-04-25T02:50:00Z [plan] tunnel/auth/phone QA scope defined
- 2026-04-25T02:51:00Z [review] external access risk review completed

- 2026-04-24T18:27:11.430Z [plan] P3 plan completed: tunnel-ready note + auth boundary + phone QA checklist.
- 2026-04-24T18:27:11.459Z [review] P3 review completed: localhost-safe baseline and external exposure risks identified.
- 2026-04-24T18:33:00Z [execute] external auth enforcement + auth meta UI + tunnel docs completed
- 2026-04-24T18:34:00Z [qa] external auth failure/success/local-mode verification passed
- 2026-04-24T18:35:00Z [acceptance] P3 accepted and phase closed

- 2026-04-24T18:31:06.503Z [execute] Executed: external auth enforcement + /api/system/meta + UI auth boundary + tunnel/phone docs.
- 2026-04-24T18:31:06.532Z [qa] QA passed: external-no-auth startup fail, unauthorized 401, authorized 200, local mode unaffected.
- 2026-04-24T18:31:06.563Z [acceptance] Acceptance approved: tunnel-ready/auth-boundary/phone-checklist complete without changing session semantics.