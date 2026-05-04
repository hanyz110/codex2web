# Codex2Web PRD

Last updated: 2026-05-04

## Product Statement

Codex2Web is an independent browser product for operating a local Codex session.

It does not modify or proxy the OpenClaw product UI.

Codex2Web is not a decorative chat app. It is a session-first workbench for giving Codex real work, watching the work stay alive, and recovering the result without losing trust.

## Primary Goal

Allow the user to open a browser page and continue the same local Codex session in real time.

The session must keep its local project context.

## Core User Outcome

The user can:

1. see live Codex output
2. send the next instruction into the same session
3. keep working inside the same local project context
4. understand which execution mode the browser is using before sending a prompt
5. later access the same browser entry from a phone through a tunnel
6. understand whether a submitted task is accepted, running, quiet, stuck, completed, or failed without refreshing
7. recover what happened in a long session without rereading the whole transcript

## Non-Goals

1. controlling the current Codex Desktop GUI window
2. screen streaming or remote desktop
3. creating a new session on every browser request
4. choosing sessions by window title or "latest project" heuristics
5. making Feishu the primary V1 product entry
6. turning the app into a game, social chat, avatar companion, or badge system
7. showing fake progress percentages that Codex2Web cannot verify
8. hiding trust boundaries, execution failures, or stop controls behind visual polish

## V1 Scope

1. local bridge process that talks to local Codex
2. browser page for a single pinned session
3. live transcript stream
4. follow-up input box
5. explicit connection, session, and send-error states
6. explicit browser execution profile with local-vs-external trust boundary
7. image + text prompt sending into the same resumed session
8. phone photo compression before upload
9. optimistic user-message rendering after send

## Product Truth Source

The browser binds to a local persistent session.

Project context is an attribute of that session, not the truth source used to guess which session to attach to.

The browser may render temporary UI state for responsiveness, but it must reconcile back to the local Codex session transcript. The transcript remains the source of truth for durable conversation history.

## V1 Success Criteria

1. browser shows live session output
2. browser sends follow-up input into the same session
3. refresh and reconnect restore the same session
4. the UI clearly shows which session is bound and what local project it belongs to
5. the UI clearly shows which browser execution mode is active
6. no Desktop GUI window recognition is required
7. text + image prompts pass images to Codex CLI as image attachments, not base64 text
8. large phone images are compressed locally before upload when needed
9. sending a prompt produces visible feedback in the transcript within 100ms

## V2 Direction

1. workbench-style chat experience
2. explicit multi-session selection
3. explicit multi-project session list
4. tunnel-based external access from phone
5. optional Feishu integration onto the same session model

## V2 Reviewed Feature: Chat Workbench Experience

### Problem

The current chat surface is functional but tiring in long sessions.

The main fatigue points are:

1. after sending a prompt, users can still feel a pause before enough visible evidence appears
2. long-running Codex work can look like the page is stuck
3. long sessions have no product-level rhythm beyond raw message order
4. completed work is not summarized in a compact result object
5. mobile users have little space, so every new UI element must earn its pixels

### Product Thesis

Make the chat feel alive by showing real work state, not by adding decoration.

The experience should communicate:

1. your prompt became a task
2. the task is alive
3. the task has a current phase
4. the task produced an outcome
5. the session can be reviewed later

### Design Review Decision

Reviewed Approach B is accepted with scope reduction.

Original Approach B contained:

1. Live Pulse
2. Prompt Card
3. Outcome Snapshot
4. Session Chapters
5. Idle Suggestions

The reviewed direction is:

1. Phase 1: Live Pulse + Prompt Card
2. Phase 2: Outcome Snapshot
3. Phase 3: Session Chapters
4. Phase 4: Idle Suggestions

Phase 1 must ship first. Do not implement all modules at once.

### Review Findings Applied

The design review changed the implementation order and scope.

Findings:

1. `Live Pulse + Prompt Card` must solve the immediate stuck-feeling problem before adding long-session navigation.
2. `Outcome Snapshot` must default to one collapsed row and expand only on intent.
3. `Session Chapters` must not auto-insert frequent dividers into the transcript.
4. mobile space is the hard constraint; every added module must preserve transcript dominance.
5. fun must come from truthful work state and recoverable outcomes, not decorative gamification.

Risks:

1. too many modules shipped together will make the chat more tiring
2. fake progress or invented summaries will erode trust
3. large persistent cards will hurt mobile usability
4. chapter automation can become visual noise if trigger rules are loose

## V2 UX Requirements

### Requirement 1: Live Pulse

Live Pulse shows whether the current task is alive.

It must:

1. use real state already known by the bridge or browser
2. show no fake percentage progress
3. explain quiet periods without implying failure too early
4. expose stuck state when runtime and visible-output thresholds are exceeded
5. make stop/retry guidance visible when execution is quiet or stalled

Allowed states:

1. `idle`: no active task
2. `pending`: browser rendered the user prompt and is sending it to the bridge
3. `starting`: Codex execution process is starting
4. `running`: execution is active and recently produced activity
5. `quiet`: process is alive but no visible output has appeared recently
6. `stalled`: process appears alive but has had no visible output or activity beyond the threshold
7. `stopping`: user requested stop
8. `completed`: process exited successfully
9. `failed`: process failed or send transport failed

Copy examples:

1. `指令已发送，正在启动执行`
2. `Codex 已接收，等待输出进入信息流`
3. `仍在执行，暂时没有新输出`
4. `执行可能卡住，建议停止后重试`
5. `本轮执行已完成`

### Requirement 2: Prompt Card

Prompt Card is the temporary product form of a submitted task.

It must:

1. appear immediately after send
2. preserve the original prompt text
3. show attachment count when images are included
4. show task state using Live Pulse state
5. offer `Stop` when execution is active
6. offer `Retry` or `Copy prompt` if send fails
7. automatically downgrade into a normal transcript message after the real session transcript catches up

Prompt Card must not:

1. become a permanent decorative card for every user message
2. take more than two content lines by default on mobile
3. hide the real transcript message once it arrives
4. introduce a second session truth source

### Requirement 3: Outcome Snapshot

Outcome Snapshot gives a compact result after each completed execution.

It must:

1. default to a one-line summary
2. expand only on user intent
3. use real observable data when possible
4. avoid hallucinated summaries

First version data sources:

1. execution exit code
2. send result
3. transcript arrival
4. changed file count from local git state when safe to compute
5. test or QA command outputs only when those commands were actually run

Default copy examples:

1. `本轮完成 · 有文件变更 · 查看`
2. `本轮完成 · 没有文件修改`
3. `本轮失败 · 退出码 1 · 查看原因`

Outcome Snapshot must not:

1. invent what Codex did
2. claim QA passed without a real QA run
3. occupy a large persistent card in the transcript

### Requirement 4: Session Chapters

Session Chapters help users review long sessions.

They must:

1. appear only at meaningful boundaries
2. be accessible from the drawer or a compact transcript divider
3. support jumping to the relevant transcript area

Allowed chapter triggers:

1. user manually marks a message as a chapter
2. session switch
3. commit created
4. external publish completed
5. long idle gap, default threshold 15 minutes

Session Chapters must not:

1. insert a divider every few messages
2. use AI-generated titles without a review path
3. make the main mobile transcript shorter by default

### Requirement 5: Idle Suggestions

Idle Suggestions give lightweight next-step prompts when no task is active.

They must:

1. reuse existing quick-command patterns
2. stay secondary to the composer
3. be dismissible or visually quiet
4. prefer action-oriented suggestions over motivational copy

Examples:

1. `继续推进`
2. `总结本轮改动`
3. `执行 QA`
4. `发布外网`
5. `提交代码`

Idle Suggestions must not:

1. become a recommendation engine that changes session state
2. crowd the composer on mobile
3. suggest destructive actions without explicit confirmation

## Visual And Interaction Constraints

The Chat Workbench must follow `DESIGN.md`.

Hard constraints:

1. keep white/gray surfaces with blue accent
2. keep transcript as the dominant region
3. do not reduce visible mobile transcript height by more than 8%
4. Live Pulse height target: 28-36px
5. Prompt Card default mobile height target: no more than 2 text lines plus one status row
6. Outcome Snapshot collapsed height target: one row
7. all controls must remain at least 44x44px where directly touchable
8. respect `prefers-reduced-motion`
9. use motion only for state change, not decoration
10. avoid avatars, badges, points, streaks, confetti, decorative blobs, and colored card walls

Allowed motion:

1. pending entry fade/translate, 150-180ms
2. Live Pulse blue dot breathing when motion is allowed
3. completed snapshot fade-in

Disallowed motion:

1. fake loading bars with arbitrary completion
2. bouncing cards
3. constant ornamental animation
4. `transition: all`

## Trust And Safety Requirements

The Chat Workbench must not weaken execution boundaries.

Requirements:

1. local vs external mode remains visible in session details
2. dangerous external execution remains explicit
3. stop remains available during active execution
4. stalled state must guide users toward stop/retry
5. browser-only optimistic UI must be reconciled with the real Codex transcript
6. refresh must not duplicate optimistic messages
7. failed sends must restore or preserve user input enough for retry

## Data Model Requirements

The browser may add temporary UI-only records.

Temporary records must:

1. have client-generated IDs
2. be marked as pending or transient
3. never be written as durable transcript truth
4. be removed or reconciled when real transcript entries arrive
5. be excluded from transcript snapshot cursors

Durable records must still come from local Codex session files or explicit project-local audit artifacts.

## Phase Plan

### Phase 1: Live Pulse + Prompt Card

Goal: make submitted work visibly alive.

Scope:

1. map existing execution state into reviewed Live Pulse states
2. render Prompt Card for pending and active sends
3. downgrade Prompt Card after real transcript reconciliation
4. add failure retry/copy affordance
5. mobile QA for transcript height and touch targets

Acceptance:

1. after send, visible task feedback appears within 100ms
2. when execution is active for more than 3 seconds, the user sees a current state
3. quiet and stalled states show different copy
4. stop remains reachable during active execution
5. failed send restores or preserves the prompt for retry
6. mobile transcript visible height regression is no more than 8%

### Phase 2: Outcome Snapshot

Goal: make each completed task recoverable without rereading the transcript.

Scope:

1. collapsed one-line completion result
2. expanded details for observable data
3. failed execution result state
4. no hallucinated summary

Acceptance:

1. successful completion creates a collapsed outcome line
2. failed completion creates a failed outcome line with cause when available
3. expanded state never claims tests or QA ran unless observed
4. snapshot does not crowd mobile transcript

### Phase 3: Session Chapters

Goal: make long sessions easier to navigate.

Scope:

1. manual chapter mark
2. chapter list in drawer
3. jump to chapter
4. limited automatic chapters for high-confidence events

Acceptance:

1. users can mark an important message as a chapter
2. drawer lists chapters with time and title
3. tapping a chapter scrolls to the relevant transcript area
4. automatic chapters do not appear more often than meaningful task boundaries

### Phase 4: Idle Suggestions

Goal: make idle state useful without becoming noisy.

Scope:

1. context-safe quick suggestions
2. reuse quick command send flow
3. mobile-safe layout

Acceptance:

1. idle suggestions are visible only when no task is active
2. suggestions do not hide the composer
3. destructive suggestions are excluded

## QA Requirements

Each phase must follow the project SOP:

1. plan
2. review
3. implement
4. real simulated QA
5. acceptance

Minimum QA matrix:

1. desktop local mode
2. mobile viewport local mode
3. external Cloudflare mode
4. send success
5. send failure
6. long-running quiet execution
7. stalled execution
8. stop execution
9. refresh during active execution
10. refresh after completion

## Success Metrics

Product success:

1. user can tell within 3 seconds whether Codex work is alive
2. user does not need to refresh to understand task state
3. user can recover the result of the last completed task in one scan
4. mobile transcript remains the primary visual region

Engineering success:

1. no session rebinding regressions
2. no duplicate durable messages caused by optimistic UI
3. no external-mode trust boundary regression
4. no fake status that cannot be traced to real browser or bridge state

## Open Questions

1. Should Outcome Snapshot read git status on every completion, or only on user expand?
2. Should Session Chapters be stored in localStorage first, or project-local `.codex2web/` state?
3. Should Retry resend immediately, or restore the prompt into the composer for explicit user confirmation?
4. Should Live Pulse appear inside the transcript, above the composer, or attached to the active Prompt Card?
