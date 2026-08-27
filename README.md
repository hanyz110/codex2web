# Codex2Web

Codex2Web is a local-first browser UI for an existing Codex CLI session.

It lets you:

1. open a real Codex session in the browser
2. keep streaming the same session transcript
3. send the next prompt into the same session
4. switch sessions explicitly across projects
5. expose the same UI to your phone through a tunnel

This project does **not** remote-control the Codex Desktop GUI. The source of truth is the local Codex session file, not a window, tab, or screen.

## Who This Is For

Codex2Web is useful if you want:

1. a mobile-friendly chat surface for Codex
2. a browser entry to continue a long-running local session
3. explicit visibility into execution mode and trust boundary
4. temporary remote access from your own phone

## Key Capabilities

1. single pinned session restore across refresh/reconnect
2. explicit multi-session discovery and switching
3. transcript streaming with snapshot fallback and reconnect watchdog
4. send and stop controls for in-flight execution
5. local vs external execution mode visibility
6. HTTP Basic Auth protection for external access
7. optional `remote-trusted` mode for local-equivalent dangerous execution on remote browsers
8. image + text prompt sending through Codex CLI image attachments
9. automatic full-history Web continuation when Codex Desktop holds the selected task's writer lock

## Requirements

1. macOS or Linux with Node.js 20+
2. Codex CLI installed locally
3. existing Codex session files on the same machine
4. Bun runtime on `PATH` if you use gstack browser tools from browser-initiated Codex turns
5. optional: `cloudflared` for phone access
6. optional: `npx` access for `localtunnel` fallback

## Quick Start

### 1. Clone

```bash
git clone https://github.com/hanyz110/codex2web.git
cd codex2web
```

### 2. Start local mode

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4321
```

### 3. Start external mode for phone access

```bash
npm run external:launch -- --port 4422
```

If you intentionally want the external browser to have the same dangerous execution authority as the local trusted browser:

```bash
npm run external:trusted -- --port 4422
```

## How It Works

1. `src/server/local-bridge.js` reads local Codex session files and exposes a stable browser-safe API
2. `src/server/dev-server.js` serves the browser app and the local bridge API
3. `src/server/public/` contains the browser UI
4. `scripts/external-access.mjs` starts an external-mode server and launches a tunnel

Recent Codex versions allow only one active writer per task. If Codex Desktop currently owns the selected task, Codex2Web uses the official app-server `thread/fork` API to create a full-history Web continuation, persists the mapping, retries the original prompt, and reuses that continuation on later sends. The source task remains unchanged, and technical continuation tasks are hidden from the Codex2Web session catalog. Live lock files are never removed or bypassed.

## Execution Profiles

Codex2Web makes browser execution policy explicit.

1. `dangerous`: runs with `--dangerously-bypass-approvals-and-sandbox`
2. `full-auto`: runs with `--full-auto`
3. `restricted`: uses the default Codex CLI behavior without extra execution flags

Defaults:

1. local mode defaults to `dangerous`
2. external mode defaults to `full-auto`
3. external `dangerous` is blocked unless you explicitly enable `--remote-trusted`

## File Attachments

The chat composer supports sending prompt text with multiple file attachments in the same turn.

Files can be added from the `+` menu, the attachment button, or by dragging them into the composer. Images continue to use Codex CLI image input; other files are stored in the local private upload directory and their paths are added to the prompt so Codex can inspect them when needed.

Large phone photos are compressed in the browser before upload. The preview shows the original and compressed sizes when compression happens.

Limits:

1. images: PNG, JPEG, WebP, GIF
2. maximum attachments per send: 10
3. maximum single file size: 20MB; maximum single image size: 5MB
4. maximum total attachment size per send: 50MB
5. maximum total image size per send: 12MB

Attachments are stored locally under `.codex2web/uploads/`. Images are passed to Codex CLI with `--image <file>`; other files are referenced by their private local path in the prompt. They are not committed to git because `.codex2web/` is ignored.

## File Downloads

Files generated inside the current session project can be downloaded directly from an AI response. The response must use an explicit Markdown link with an absolute local path, for example `[下载报表](</absolute/project/path/季度 报表.xlsx>)`.

Downloads support any regular file type, including PDF, Excel, Word, PowerPoint, images, archives, Markdown, and source files. Before the browser starts a native streaming download, Codex2Web validates that the real file path remains inside the project bound to the current browser session. Plain paths and paths inside inline code are not automatically converted into download links.

## External Access

External access always requires an auth boundary.

When external mode is enabled:

1. Basic Auth is mandatory
2. the UI shows the current auth and execution mode
3. the tunnel exposes the same session model, not a different remote control surface

See:

1. [Getting Started](docs/getting-started.md)
2. [Tunnel Setup](docs/tunnel-ready.md)
3. [Security Notes](docs/security.md)
4. [Troubleshooting](docs/troubleshooting.md)

## Project Structure

```text
src/
  server/
    dev-server.js         HTTP server + API surface
    local-bridge.js       Codex session bridge
    public/               Browser UI assets
scripts/
  external-access.mjs     Tunnel launcher and external-mode bootstrap
  spec-kit.mjs            Phase and gate helper
spec-kit/
  README.md               Spec-kit workflow notes
docs/
  *.md                    Product, SOP, architecture, setup, troubleshooting
```

## Common Commands

```bash
npm run dev
npm run start
npm run external:health -- --pass '<password>'
npm run external:install-launchd -- --pass '<password>'
npm run external:launch -- --port 4422
npm run external:launchd-status
npm run external:trusted -- --port 4422
npm run external:uninstall-launchd
npm run spec:status
npm run spec:autoplan
npm run spec:gate
```

## Documentation Index

1. [Getting Started](docs/getting-started.md)
2. [Architecture](docs/architecture.md)
3. [PRD](docs/prd.md)
4. [SOP](docs/sop.md)
5. [Execution Plan](docs/execution-plan.md)
6. [Tunnel Ready Deployment Note](docs/tunnel-ready.md)
7. [Phone QA Checklist](docs/phone-qa-checklist.md)
8. [Security Notes](docs/security.md)
9. [Troubleshooting](docs/troubleshooting.md)
10. [Spec Kit Workflow](spec-kit/README.md)
11. [Contributing](CONTRIBUTING.md)
12. [Security Policy](SECURITY.md)
13. [Changelog](CHANGELOG.md)
14. [GitHub Issue Templates](.github/ISSUE_TEMPLATE)
15. [Pull Request Template](.github/pull_request_template.md)

## Repository Standards

1. license: [MIT](LICENSE)
2. contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
3. security policy: [SECURITY.md](SECURITY.md)
4. example environment variables: [.env.example](.env.example)
5. code owners: [.github/CODEOWNERS](.github/CODEOWNERS)

## Known Constraints

1. this project depends on local Codex session files being present on the same machine
2. the tunnel launcher currently starts a dedicated external-mode server instance
3. quick Cloudflare tunnel URLs are temporary and may expire
4. mobile browsers and tunnel layers may still require a hard refresh after deployment changes

## Intended Usage Boundary

This project is for personal or team-controlled access to your own Codex environment.

Do not expose it publicly without understanding the execution profile, auth boundary, and tunnel risks.
