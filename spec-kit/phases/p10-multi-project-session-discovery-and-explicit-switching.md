# P10 - Multi-Project Session Discovery and Explicit Switching

## Metadata

- phase_id: `P10`
- title: `Multi-Project Session Discovery and Explicit Switching`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Allow the browser to explicitly switch between local Codex sessions that belong to different projects, without relying on heuristics or changing the session-first operating model. Users should be able to see a deterministic cross-project session catalog, understand which local project each session belongs to, and intentionally attach to a different project session from the same browser surface.

## Non-Goals

1. Do not reintroduce latest-active or project-name guessing.
2. Do not create or clone sessions automatically when a target project has no existing session.
3. Do not redesign tunnel/auth behavior in this phase.

## Deliverables

1. Bridge support for discovering local sessions across projects instead of filtering to the current app project only.
2. Explicit browser UX for viewing and switching sessions with visible project grouping or project labels.
3. QA coverage proving cross-project switching remains explicit, auditable, and stable across refresh/reconnect.

## Exit Criteria

1. The session candidate list can include sessions from more than one local project.
2. Switching to another project session requires explicit user action and updates pinned identity correctly.
3. Refresh/reconnect restore the explicitly selected session without silent rebinding.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. PRD V2 already includes `explicit multi-session selection` and `explicit multi-project session list`, but current implementation only surfaces sessions whose `projectPath` matches the app project.
2. The main architecture risk is scope expansion in discovery: we need broader enumeration while preserving stable identity and avoiding any project-based guessing.
3. Planned sequence:
   - remove single-project filtering from discovery in a controlled way
   - expose project-aware session metadata to the UI
   - redesign switch UX for cross-project readability and safety
   - QA refresh/reconnect/audit paths across project boundaries

## Review Notes

1. Review conclusion: this feature is in-scope for the product roadmap, but not yet delivered by the current bridge implementation.
2. Current blocker is concrete and code-level: `LocalSessionBridge.#refreshSessions` filters out sessions whose `projectPath !== this.#projectPath`.
3. Decision: keep the attach contract explicit and reuse the existing audit model instead of inventing a second switching mechanism.

## Execute Notes

1. Removed the bridge-level single-project filter so local session discovery now includes sessions from different project roots as long as they have a stable session id and cwd.
2. Tightened startup pin semantics: when multiple local sessions exist and no persisted pin is present, the bridge now stays unbound instead of silently selecting the first discovered session.
3. Updated the browser switch drawer to group candidate sessions by project, show full project paths, and label same-project versus cross-project switches explicitly.

Changed files:
1. `src/server/local-bridge.js`
2. `src/server/public/app.js`
3. `src/server/public/app.css`

## QA Notes

1. Server-side discovery check passed after restart: `/api/sessions` surfaced sessions from multiple project roots instead of only the app project.
2. Direct API QA switched from the current `codex2web` session to session `019d15c7-daf2-7452-b2b7-5af274c430d6` in `/Users/honesty/openclaw`, confirmed binding changed, then restored the original pinned session.
3. Audit QA confirmed `session_switch` entries recorded both the cross-project switch and the restoration back to the original session.
4. Browser QA with Playwright confirmed the drawer renders project-group headers and cross-project tags; screenshot evidence captured at `/tmp/p10-drawer.png`.
5. Startup semantics QA with a temporary state file confirmed:
   - with multiple discovered sessions and no persisted pin, `pinnedSessionId` remains `null`
   - with a persisted cross-project pin, the bridge restores that explicit session correctly
6. Syntax checks passed:
   - `node --check src/server/local-bridge.js`
   - `node --check src/server/public/app.js`

## Acceptance Notes

Go. P10 is accepted.

Acceptance rationale:
1. Cross-project sessions are now discoverable and switchable without reintroducing heuristics.
2. Explicit session switching semantics remained intact and auditable.
3. Silent fallback risk was reduced by removing ambiguous multi-session auto-binding on startup.

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T03:01:00.024Z [plan] P10 plan locked: explicit cross-project session discovery and switching without relaxing session-first semantics or introducing guessing.
- 2026-04-25T03:01:00.052Z [review] P10 review confirmed PRD V2 coverage but identified current bridge filtering by projectPath as the concrete implementation blocker.

- 2026-04-25T03:10:30.130Z [execute] P10 execute removed single-project session filtering, tightened startup pin fallback semantics, and grouped explicit switch candidates by project in the drawer.
- 2026-04-25T03:10:30.158Z [qa] P10 QA passed: /api/sessions now spans multiple projects, cross-project attach to /Users/honesty/openclaw succeeded and restored cleanly, session_switch audit entries were recorded, Playwright verified grouped drawer UI, and startup tests confirmed no silent multi-session fallback.
- 2026-04-25T03:10:30.187Z [acceptance] Accepted: cross-project session discovery and explicit switching now work without breaking session-first or no-heuristics constraints.