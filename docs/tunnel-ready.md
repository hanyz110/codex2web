# Codex2Web Tunnel-Ready Deployment Note

## Objective

Expose the same browser entry externally without changing session semantics.

## Hard Rule

When running in external mode (`HOST != 127.0.0.1` or `CODEX2WEB_EXTERNAL=true`), auth boundary is mandatory.

Server enforcement is built in:

1. if external mode is on and auth vars are missing, server exits immediately
2. if auth vars are present, all routes require HTTP Basic Auth

Required env vars:

1. `CODEX2WEB_BASIC_USER`
2. `CODEX2WEB_BASIC_PASS`

## One-Command Launch

Preferred project-local entry:

```bash
npm run external:launch -- --port 4421
```

Trusted shortcut:

```bash
npm run external:trusted -- --port 4421
```

Behavior:

1. starts Codex2Web in `external mode`
2. enforces Basic Auth automatically
3. launches a tunnel provider
4. prints the public URL plus the Basic Auth credentials
5. keeps the default external execution profile at `full-auto` unless you explicitly opt into remote trusted mode

Provider selection:

1. preferred: `cloudflared`
2. fallback: `localtunnel` via `npx`

Examples:

```bash
npm run external:launch -- --port 4421 --provider cloudflared
npm run external:launch -- --port 4421 --provider localtunnel
npm run external:launch -- --port 4421 --provider cloudflared --allow-unverified-public
npm run external:launch -- --port 4421 --provider cloudflared --remote-trusted
```

`--allow-unverified-public` usage:

1. use only when the local host cannot resolve the generated quick-tunnel domain
2. launcher will still print URL + credentials and keep the server/tunnel alive
3. public verification fields may show `unverified/unknown` and should be checked from a different resolver path (phone network, DoH-assisted curl, or another machine)

Recommendation:

1. use `cloudflared` for the cleanest phone experience
2. use `localtunnel` only as a fallback because some browsers may show a tunnel reminder/interstitial page first

## Named Tunnel / Fixed Hostname

If you want a stable hostname instead of a temporary `trycloudflare.com` URL, the launcher now supports an existing Cloudflare named tunnel.

Required inputs:

1. `--tunnel-id`
2. `--hostname`
3. `--credentials-file`
4. optional: `--tunnel-name`

Example:

```bash
npm run external:trusted -- \
  --port 4422 \
  --provider cloudflared \
  --tunnel-id 11111111-2222-3333-4444-555555555555 \
  --tunnel-name codex2web \
  --hostname codex2web.example.com \
  --credentials-file ~/.cloudflared/11111111-2222-3333-4444-555555555555.json
```

Equivalent env vars:

1. `CODEX2WEB_CLOUDFLARE_TUNNEL_ID`
2. `CODEX2WEB_CLOUDFLARE_TUNNEL_NAME`
3. `CODEX2WEB_CLOUDFLARE_HOSTNAME`
4. `CODEX2WEB_CLOUDFLARE_CREDENTIALS_FILE`

Behavior:

1. launcher generates a stable cloudflared config under `~/Library/Application Support/codex2web/runtime/` with ingress pointing to local `127.0.0.1:<port>`
2. cloudflared runs the named tunnel instead of requesting a quick tunnel
3. public URL becomes the fixed hostname you provided
4. the same Basic Auth and execution profile checks still apply

Prerequisite:

1. this machine must already have a Cloudflare tunnel created in your account and a matching credentials JSON file
2. if you still need to create the tunnel and DNS route, do that once with a logged-in `cloudflared` session (`cloudflared tunnel login`, `cloudflared tunnel create`, `cloudflared tunnel route dns ...`)

## Remote Trusted Mode

If you explicitly need the phone browser to have the same execution authority as the local trusted browser, start the external launcher with:

```bash
npm run external:launch -- --port 4421 --remote-trusted
```

Equivalent lower-level env:

```bash
HOST=0.0.0.0 \
PORT=4421 \
CODEX2WEB_EXTERNAL=true \
CODEX2WEB_REMOTE_TRUSTED=true \
CODEX2WEB_BASIC_USER=codex2web \
CODEX2WEB_BASIC_PASS='change-me-now' \
npm run dev
```

Behavior:

1. external access still requires Basic Auth
2. `/api/system/meta` reports `execution.profile: dangerous`
3. the browser UI shows `远程完全权限`
4. this is intentionally high risk and should be used only for temporary personal access you control

## Local Start (External-Ready)

```bash
HOST=0.0.0.0 \
PORT=4321 \
CODEX2WEB_EXTERNAL=true \
CODEX2WEB_BASIC_USER=codex2web \
CODEX2WEB_BASIC_PASS='change-me-now' \
npm run dev
```

Use this lower-level form only if you want to manage the tunnel process yourself.

## Tunnel Example (Cloudflared)

```bash
cloudflared tunnel --url http://127.0.0.1:4321
```

## Tunnel Example (ngrok)

```bash
ngrok http 4321
```

## Security Boundary Checklist

1. keep server auth enabled before exposing tunnel URL
2. use strong random password, rotate after each temporary exposure
3. do not disable session pinning semantics for external requests
4. shut down tunnel when not in active use
5. only enable `--remote-trusted` when you intentionally want local-equivalent dangerous execution on the remote phone path

## Verification

1. opening tunnel URL without credentials returns `401 Authentication Required`
2. with credentials, `/api/system/meta` returns `authMode: basic`
3. with credentials, `/api/system/meta` returns `execution.profile: full-auto` on external path
4. session identity remains stable across refresh/reconnect

Remote trusted verification:

1. launch with `--remote-trusted`
2. with credentials, `/api/system/meta` returns `execution.profile: dangerous`
3. with credentials, `/api/system/meta` returns `security.remoteTrusted: true`

DoH-assisted verification example (for resolver-restricted hosts):

```bash
DOMAIN='<your-trycloudflare-domain>'
IP=$(curl -sS "https://cloudflare-dns.com/dns-query?name=${DOMAIN}&type=A" \
  -H 'accept: application/dns-json' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const a=(j.Answer||[]).find(x=>x.type===1);if(!a)process.exit(2);process.stdout.write(a.data);});")
AUTH=$(printf 'codex2web:<password>' | base64)
curl -i --resolve "${DOMAIN}:443:${IP}" "https://${DOMAIN}/api/system/meta" \
  -H "Authorization: Basic ${AUTH}"
```

## macOS Auto-Restart

For a stable personal external entry, install the launchd watchdog so the external server and Cloudflare connector restart after crashes, terminal exits, or login restarts:

```bash
npm run external:install-launchd -- \
  --port 4422 \
  --user codex2web \
  --pass 'change-me-now' \
  --hostname codex2web.idea-search.com \
  --tunnel-id da1e0fbb-39ec-49f2-a66c-ce3caed9778f \
  --tunnel-name codex2web \
  --credentials-file ~/.cloudflared/da1e0fbb-39ec-49f2-a66c-ce3caed9778f.json
```

Operational checks:

```bash
npm run external:launchd-status
npm run external:health -- --pass 'change-me-now' --attempts 3
```

Behavior:

1. launchd keeps `npm run external:trusted` alive with `KeepAlive=true`
2. credentials are stored in `~/Library/Application Support/codex2web/external/launchd.env` with `0600` permissions
3. logs are written to `~/Library/Logs/codex2web/external-launchd.*.log`
4. uninstall with `npm run external:uninstall-launchd`
