# Troubleshooting

## The page stays on "Restoring session"

Check:

1. Codex2Web server is running
2. the local machine has accessible Codex session files
3. the browser can reach `/api/session/binding`
4. external mode credentials are correct

Useful checks:

```bash
curl http://127.0.0.1:4321/api/system/meta
curl http://127.0.0.1:4321/api/session/binding
```

For external mode:

```bash
curl -u '<user>:<pass>' http://127.0.0.1:4422/api/system/meta
curl -u '<user>:<pass>' http://127.0.0.1:4422/api/session/binding
```

## Mobile browser shows stale UI after tunnel launch

1. hard refresh the page
2. reopen the tunnel URL
3. confirm the server returns `cache-control: no-store`
4. confirm the external server process was restarted after code changes

## Error: invalid session state / non-JSON response

This usually means the external browser got an unexpected tunnel or auth response instead of the expected JSON payload.

Try:

1. refresh the page
2. re-enter Basic Auth credentials
3. restart the external launcher
4. verify the tunnel URL still points to the current process

## Send button disabled

Check the top status indicators.

Typical causes:

1. bridge connection is down
2. session attach failed
3. a previous execution is still running or stopping

## Stop does not work

1. confirm the UI is currently in `sending` state
2. use the stop button only while an execution is active
3. if the underlying Codex child process is already gone, the bridge will return `idle` instead of `stopped`

## External URL is dead

Quick tunnel URLs are temporary.

Fix:

1. rerun `npm run external:launch -- --port 4422`
2. use the newly printed URL
3. for a stable hostname, switch to a named Cloudflare tunnel

For the stable `codex2web.idea-search.com` path, use the launchd-backed service instead of a manually kept terminal process:

```bash
npm run external:launchd-status
npm run external:health -- --pass '<password>' --attempts 3
```

If launchd is not loaded or the health check fails, reinstall it:

```bash
npm run external:install-launchd -- --pass '<password>'
```

## Public URL works but phone does not update in real time

1. verify `/api/session/stream` is reachable
2. verify snapshot polling still works
3. verify the page is not on an old cached script
4. restart the external process and reconnect the tunnel

## Browser-triggered gstack browse says Bun is missing

Root cause: the external service is often started by `launchd`, which does not inherit the same shell startup files as your terminal. If the service `PATH` lacks `~/.bun/bin`, a browser-initiated Codex turn can fail with:

```text
[browse] Executable not found in $PATH: "bun"
```

Fix:

1. reinstall or restart the launchd service so it writes the normalized runtime `PATH`
2. run `npm run external:health -- --pass '<password>' --attempts 3`
3. confirm the health output has `localRuntimeBun=true` and `publicRuntimeBun=true`

## No sessions are found

This project does not create hidden replacement sessions.

Check:

1. Codex CLI has already created at least one local session
2. the session files are accessible to the current user
3. the machine running Codex2Web is the same machine that owns those sessions
