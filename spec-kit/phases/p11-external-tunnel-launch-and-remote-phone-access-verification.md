# P11 - External Tunnel Launch and Remote Phone Access Verification

## Metadata

- phase_id: `P11`
- title: `External Tunnel Launch and Remote Phone Access Verification`
- created_at: `2026-04-25`
- owner: `codex2web`
- source_of_truth: `docs/sop.md`

## Goal

Operationalize remote phone access so the product is not just tunnel-ready on paper, but straightforward to expose and verify from outside the local network. The same browser surface should be reachable on a phone through an authenticated tunnel with a repeatable launch flow and real remote QA evidence.

## Non-Goals

1. Do not change session pinning semantics for external users.
2. Do not weaken or bypass the auth boundary introduced in P3.
3. Do not add a separate mobile app or alternate remote-control surface.

## Deliverables

1. A repeatable external launch flow for local server + tunnel provider.
2. Remote phone validation evidence using the existing browser surface and auth boundary.
3. Documentation or automation that reduces setup friction for temporary external exposure.

## Exit Criteria

1. A user can bring the app online for external phone access without manual guesswork beyond tunnel-provider credentials.
2. Auth is enforced for external entry and verified on the exposed URL.
3. Core phone flows pass against the real external entry, not only localhost simulation.

## Closed Loop Gates

- [x] plan
- [x] review
- [x] execute
- [x] qa
- [x] acceptance

## Plan Notes

1. PRD includes phone-through-tunnel access and P3 already established the auth boundary, but current delivery stops at `tunnel-ready` docs and checklists.
2. The remaining product gap is operational: making external launch repeatable and proving the real phone path works outside localhost.
3. Planned sequence:
   - standardize launch procedure for external mode
   - choose/document supported tunnel path
   - run remote phone QA against the real external URL
   - capture security constraints and shutdown guidance

## Review Notes

1. Review conclusion: the capability is included in the roadmap and partially implemented, but not yet productized end-to-end.
2. Existing assets to reuse: `docs/tunnel-ready.md`, `docs/phone-qa-checklist.md`, and auth enforcement in `src/server/dev-server.js`.
3. Decision: keep P11 focused on operationalization and real verification, not auth redesign.

## Execute Notes

1. Added a repeatable external launch entry at `scripts/external-access.mjs` and exposed it via `npm run external:launch`.
2. The launch flow now starts Codex2Web in external mode, enforces Basic Auth, starts a tunnel provider, prints the public URL plus credentials, and performs public verification checks.
3. Added provider strategy to the docs:
   - preferred: `cloudflared`
   - fallback: `localtunnel`
4. Updated the launch script to prefer a project-local `cloudflared` binary when available, so the project is not blocked on a global install.
5. Hardened public verification handling for DNS-restricted environments:
   - external launcher now supports `--allow-unverified-public`
   - when enabled, launcher continues to print URL + credentials and keep processes alive even if local host cannot resolve the quick-tunnel domain
   - launcher output now includes `execution.profile` verification status

Changed files:
1. `scripts/external-access.mjs`
2. `package.json`
3. `docs/tunnel-ready.md`

## QA Notes

Completed checks:
1. `cloudflared` launch path is now available and reproducible:
   - `npm run external:launch -- --port 4441 --provider cloudflared --allow-unverified-public`
   - external mode started with Basic Auth boundary and published a quick-tunnel URL.
2. Public URL and auth boundary were verified with DoH-assisted host resolution (`curl --resolve`):
   - unauthenticated `GET /` returned `401 Authentication Required`
   - authenticated `GET /api/system/meta` returned:
     - `security.authMode = basic`
     - `externalMode = true`
     - `execution.profile = full-auto` (matches P14 guardrail)
3. Real runtime send evidence from browser path was captured in-session via iOS QA payload:
   - `P11 external qa ios 1777090267427`
4. Existing fallback path (`localtunnel`) remains available for environments where clean-provider DNS lookup is restricted.

Environment note:
1. In this host environment, direct local DNS resolution for some `*.trycloudflare.com` names is unstable/blocked, so launcher-side local `fetch` verification can fail even when the tunnel itself is online.
2. `--allow-unverified-public` keeps the operational flow usable while preserving auth boundary and explicit execution mode checks.

## Acceptance Notes

1. Accepted: external launch is now operational with preferred provider (`cloudflared`) and explicit auth boundary.
2. Accepted: public verification confirms unauthorized `401`, authorized `authMode=basic`, and external execution guardrail (`full-auto`) on the exposed URL.
3. Accepted: browser-driven send path evidence is present for phone QA flow.
4. Follow-up outside this phase:
   - continue collecting cross-device (especially Android) live run notes as ongoing operational QA
   - keep `cloudflared` DNS limitations documented for developer environments with restricted resolvers

## Evidence Log

- YYYY-MM-DDTHH:mm:ssZ [plan] ...

- 2026-04-25T03:01:00.080Z [plan] P11 plan locked: operationalize tunnel-based external phone access on top of the auth boundary and existing phone QA checklist.
- 2026-04-25T03:01:00.107Z [review] P11 review confirmed roadmap coverage and existing tunnel/auth assets, with remaining gap in repeatable external launch and real remote QA.

- 2026-04-25T03:25:25.600Z [execute] P11 execute added a repeatable external launcher, package script, and provider guidance; external mode + tunnel startup now produces a public URL with Basic Auth verification.
- 2026-04-25T04:13:46.420Z [qa] Cloudflared launch path validated with external auth boundary; public checks confirmed 401 unauth and authMode=basic + execution.profile=full-auto via DoH-assisted verification. iOS browser-path send evidence captured in-session (P11 external qa ios ...).
- 2026-04-25T04:13:46.450Z [acceptance] Accepted: external phone-access path is operationalized with preferred provider, explicit auth boundary, and external execution guardrail. Remaining Android notes moved to ongoing operational QA.
