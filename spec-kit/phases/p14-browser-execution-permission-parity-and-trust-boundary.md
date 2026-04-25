# P14 - Browser Execution Permission Parity and Trust Boundary

## Metadata

- phase_id: `P14`
- title: `Browser Execution Permission Parity and Trust Boundary`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Ensure browser-initiated turns are no longer silently downgraded into an implicit Codex CLI default permission mode. When the user sends a prompt from the browser, the execution authority must be explicit, inspectable, and intentionally configured so the browser surface can operate as a real continuation surface for local Codex work. At the same time, external access must not accidentally expose dangerous execution power without an explicit trust boundary.

## Non-Goals

1. Do not attempt remote control of the existing Codex Desktop GUI process.
2. Do not assume the browser can literally inherit the current desktop thread's hidden runtime state; parity here means explicit capability parity, not magical process reuse.
3. Do not remove the external auth boundary or silently enable dangerous execution over public tunnels.

## Deliverables

1. A defined browser execution-permission model, including at minimum explicit local and external trust behavior.
2. Bridge-level support for explicit Codex execution profiles instead of relying on implicit CLI defaults.
3. UI and API visibility for the active execution mode so the user can see why browser execution can or cannot perform privileged actions.

## Exit Criteria

1. Browser sends no longer rely on hidden/default Codex CLI approval and sandbox behavior.
2. The user can tell which execution mode is active before sending a prompt.
3. Local trusted mode and external mode have explicit, testable, and documented safety behavior.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. Current root cause is architectural, not cosmetic: `src/server/local-bridge.js` sends browser prompts by spawning `codex exec resume <session> - --skip-git-repo-check --json`, which is a separate non-interactive CLI continuation path.
2. That continuation path does not inherit the Codex Desktop app thread policy seen in this workspace. It falls back to the CLI's own execution policy and currently passes no explicit permission/profile flags.
3. Local inspection shows:
   - browser bridge code does not expose execution mode in API or UI
   - project docs promise same session and project context, but do not yet promise permission parity
   - current user config does not pin default sandbox/approval behavior in `~/.codex/config.toml`
4. Planned sequence:
   - define execution trust model for browser sends
   - decide how local-only trusted mode and external mode differ
   - implement explicit spawn flags/profile handling in the bridge
   - surface current mode in the UI
   - QA parity with representative file/system actions

## Review Notes

1. Review conclusion: this is a product-gap phase that should be prioritized ahead of further external-control polish, because browser execution without explicit authority semantics is not a credible "operate Codex from browser" surface.
2. Confirmed implementation fact: current bridge omits explicit execution controls when spawning Codex, so permission behavior is left to CLI defaults.
3. Confirmed CLI capability: `codex exec resume` supports explicit elevation paths such as `--full-auto` and `--dangerously-bypass-approvals-and-sandbox`, plus config overrides and profiles.
4. Design decision for implementation phase:
   - local trusted mode should support an explicit elevated execution profile
   - external mode must not silently run with dangerous power
   - the browser must display the current execution mode instead of leaving users to infer it from failures
5. Open architecture question to resolve during execute:
   - whether to model execution as named profiles (`restricted`, `full-auto`, `dangerous`) or as raw Codex flags/config values
   - preferred direction is named profiles, because that is safer to expose in product UI and easier to QA

## Execute Notes

1. Added explicit execution-profile resolution in `src/server/dev-server.js` with three named modes:
   - `dangerous`
   - `full-auto`
   - `restricted`
2. Local default now resolves to `dangerous`, so browser sends no longer depend on hidden Codex CLI defaults when running in local trusted mode.
3. External mode default now resolves to `full-auto`, and `dangerous` is hard-blocked when the external auth boundary is enabled.
4. Updated `src/server/local-bridge.js` to:
   - accept an explicit execution policy object
   - accept an overridable Codex binary path for QA instrumentation
   - include execution policy in binding state
   - spawn `codex exec resume` with explicit flags instead of implicit defaults
5. Updated browser UI to show the active execution mode and policy summary in the drawer and composer context.
6. Updated product and architecture docs to record execution-profile semantics as part of the shipped behavior.

## QA Notes

1. Static validation:
   - `node --check src/server/dev-server.js`
   - `node --check src/server/local-bridge.js`
   - `node --check src/server/public/app.js`
2. Local trusted mode verification with mock Codex binary:
   - `/api/system/meta` returned profile `dangerous`
   - `/api/session/send` succeeded
   - captured spawn args: `exec resume --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json <session> -`
3. External guarded mode verification with mock Codex binary and basic auth:
   - `/api/system/meta` returned profile `full-auto`
   - authenticated `/api/session/send` succeeded
   - captured spawn args: `exec resume --full-auto --skip-git-repo-check --json <session> -`
4. External dangerous-mode refusal:
   - starting the server with `CODEX2WEB_EXTERNAL=true` and `CODEX2WEB_EXECUTION_PROFILE=dangerous` failed fast with:
     `Refusing to start with execution profile=dangerous while external auth boundary is enabled.`
5. UI verification via Playwright against the local page:
   - `#composerContext` showed `当前执行模式：本地完全权限`
   - `#executionMode` showed `execution: 本地完全权限`
   - `#executionSummary` showed the policy summary text
6. Replaced the active localhost `:4321` server with a new instance running the updated code and verified `/api/system/meta` now reports the explicit execution policy.

## Acceptance Notes

1. Go: browser execution no longer relies on implicit Codex CLI defaults.
2. Go: the active execution mode is visible in the UI and API before sending a prompt.
3. Go: local trusted and external guarded behavior are now explicitly separated.
4. Follow-up remains outside this phase:
   - `P11` still needs real external phone QA on the public URL
   - `P12` still needs in-flight stop/cancel semantics

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T03:45:36.010Z [plan] P14 planned from confirmed architecture gap: browser sends currently spawn codex exec resume without explicit permission/profile controls, so execution authority is left to CLI defaults.
- 2026-04-25T03:45:36.039Z [review] Review approved prioritizing explicit browser execution profiles and local-vs-external trust boundary before further remote-control polish. CLI support exists via full-auto/dangerous/config-profile paths.

- 2026-04-25T03:57:07.085Z [execute] Implemented explicit browser execution profiles in dev-server/local-bridge, surfaced the active mode in the UI, and added a Codex binary override for QA instrumentation.
- 2026-04-25T03:57:07.113Z [qa] QA passed with static checks, mock-Codex spawn verification for local dangerous and external full-auto modes, dangerous external startup refusal, UI rendering validation, and localhost :4321 restart verification.
- 2026-04-25T03:57:07.141Z [acceptance] Accepted: browser sends now use explicit execution profiles with visible trust boundaries, eliminating implicit CLI-default permission behavior.
