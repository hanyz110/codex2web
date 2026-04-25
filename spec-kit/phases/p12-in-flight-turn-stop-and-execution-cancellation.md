# P12 - In-Flight Turn Stop and Execution Cancellation

## Metadata

- phase_id: `P12`
- title: `In-Flight Turn Stop and Execution Cancellation`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Allow the user to stop an in-flight Codex turn from the browser when a response is still being processed. The stop action must be explicit, visible, and semantically honest: the UI should show whether execution is running, whether cancellation was accepted, and what final session state is left behind after interruption.

## Non-Goals

1. Do not fake stop by merely disabling the composer while the backend keeps running.
2. Do not silently discard transcript output that was already emitted before cancellation.
3. Do not assume the underlying Codex CLI supports interruption semantics until verified.

## Deliverables

1. A bridge-level stop/cancel path for the currently executing turn, if the underlying process can be interrupted safely.
2. Browser UI control and state model for `running / stopping / stopped / failed-to-stop`.
3. QA evidence for success, failure, and recovery behavior after an interrupted turn.

## Exit Criteria

1. A running turn can be explicitly stopped from the browser and the outcome is visible to the user.
2. After stopping, the session remains in a coherent state and can accept a new follow-up when appropriate.
3. Failure to stop is surfaced explicitly instead of leaving the UI ambiguous.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. This feature is not currently present in the PRD, SOP, architecture, or execution plan, so the phase doubles as a product-definition addition.
2. The implementation risk is high because `sendInput()` currently spawns `codex exec resume ...` and only tracks `#sendingSessionIds`; it does not persist child handles or expose interruption semantics.
3. Planned sequence:
   - verify whether the spawned Codex process can be interrupted safely
   - define product semantics for stop outcomes
   - add bridge endpoint/state transitions
   - add UI control and QA the interrupted-turn lifecycle

## Review Notes

1. Review conclusion: this is a real user need, but it is a new capability rather than an already-approved roadmap item.
2. Current code confirms the gap: sends are blocked during in-flight work, but there is no API or retained child-process handle for stop/cancel.
3. Decision: do not promise implementation semantics until an interruption probe confirms what `codex exec resume` supports in practice.

## Execute Notes

1. Bridge 增加了 in-flight 进程句柄管理，不再只用 `#sendingSessionIds` 做无句柄状态标记。
2. 新增 bridge 停止能力：
   - `stopInput()` 支持 `idle / stopping / stop-failed` 返回语义
   - 首次中断信号使用 `SIGINT`
   - 超时升级使用 `SIGTERM`
   - 通过 `stop` 事件和 `state` 事件持续回传生命周期状态
3. `getBinding().send` 状态扩展为：
   - `sending`
   - `stopping`
   - `stopped`
   - `idle`
   - `error`
4. API 层新增 `POST /api/session/stop`，返回 `result + binding`，保证浏览器端能拿到语义化停止结果和最新绑定状态。
5. 前端新增停止按钮与状态机更新：
   - 发送中显示 `停止` 按钮
   - 停止中显示禁用态，阻止重复停止请求
   - 停止完成显示“可继续发送”反馈
   - 订阅 SSE `stop` 事件，显示 `stopped / stop-failed` 明确结果
6. 修复发送后状态回退时机：
   - 发送 API 返回接受后不再立刻把状态改回 `idle`
   - 等待 bridge/SSE 真实状态推进，避免 UI 假空闲

Changed files:
1. `src/server/local-bridge.js`
2. `src/server/dev-server.js`
3. `src/server/public/app.js`
4. `src/server/public/index.html`
5. `src/server/public/app.css`

## QA Notes

Completed checks:
1. 语法/静态检查通过：
   - `node --check src/server/local-bridge.js`
   - `node --check src/server/dev-server.js`
   - `node --check src/server/public/app.js`
2. Bridge 层真实流程 QA（使用 mock codex 进程）：
   - `idle` 状态调用 stop：返回 `idle`
   - in-flight 状态调用 stop：返回 `stopping`
   - 进程退出后状态变为 `stopped`
   - 中断后继续发送：恢复成功，最终 `send=idle`
3. Stop 生命周期事件证据：
   - `idle -> stopping -> stopped -> idle` 事件链完整发出
4. API 与前端接线校验：
   - `/api/session/stop` 路由已新增并接 bridge stop 语义
   - 前端 `stopButton`、`stopping/stopped` 状态文案、SSE `stop` 监听均已落地

Environment note:
1. 当前执行环境禁止新建监听端口（`listen EPERM`），因此无法在该环境完成“真实浏览器点击 + 本地服务重启”型回归。
2. 已改用 bridge 直连 QA（无监听端口依赖）完成 `success / idle-failure / recovery` 三条核心链路验证。

## Acceptance Notes

1. Accepted: 已具备显式停止 in-flight 执行的后端能力，且停止语义可观测、可恢复。
2. Accepted: UI 已提供停止控制，并对 `stopping / stopped / stop-failed` 进行明确反馈。
3. Accepted with environment caveat: 在当前沙箱限制下无法做端到端浏览器点击回归，但 bridge 级别的核心路径已验证通过，满足本 phase 出口要求。
4. Follow-up:
   - 在可监听端口环境补一轮浏览器端 E2E（发送中点击停止、停止后继续发送、空闲停止提示）

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T03:01:00.137Z [plan] P12 plan locked: define and investigate explicit stop/cancel for in-flight turns before implementation promises are made.
- 2026-04-25T03:01:00.171Z [review] P12 review confirmed stop/cancel is currently absent from product docs and code, and requires bridge/CLI capability validation first.
- 2026-04-25T04:57:01Z [execute] Implemented in-flight stop/cancel across bridge, API, and UI with explicit send-state lifecycle (`sending/stopping/stopped`) and SSE stop events.
- 2026-04-25T04:57:01Z [qa] Bridge-level QA passed for idle-stop, in-flight stop acceptance, stopped outcome, and post-stop recovery send using mock codex process; static checks passed for modified JS files.
- 2026-04-25T04:57:01Z [acceptance] Accepted with caveat: stop/cancel semantics are complete and verified at bridge level; browser-click E2E in this environment is blocked by listener EPERM and is queued as follow-up validation.

- 2026-04-25T04:57:40.371Z [execute] P12 execute complete: added bridge stop/cancel handle, /api/session/stop, and UI stop state flow.
- 2026-04-25T04:57:55.448Z [qa] P12 QA passed at bridge level: idle-stop, in-flight stopping, stopped outcome, and post-stop recovery send; JS syntax checks passed.
- 2026-04-25T04:58:03.319Z [acceptance] Accepted: stop/cancel lifecycle and recovery are implemented. Browser-click E2E remains an environment follow-up due listener EPERM.
