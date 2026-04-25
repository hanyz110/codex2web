# Getting Started

## What You Need

1. Node.js 20+
2. Codex CLI installed locally
3. at least one Codex session already present on this machine
4. optional: `cloudflared` if you want phone access through the internet

## Local Start

Run:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:4321
```

What you should see:

1. the page restores one pinned session
2. transcript history loads
3. the header shows connection state and execution mode

## External Start

Run:

```bash
npm run external:launch -- --port 4422
```

The launcher will:

1. start a dedicated external-mode Codex2Web server
2. require HTTP Basic Auth
3. launch a tunnel provider
4. print the public URL and credentials

## Remote Trusted Mode

Use this only if you intentionally want remote browsers to have the same dangerous execution authority as your local trusted browser.

```bash
npm run external:trusted -- --port 4422
```

## Basic Usage Flow

1. open the page
2. confirm the session name and project path
3. read the current execution mode in the details drawer
4. type the next prompt
5. wait for transcript updates
6. use `Stop` if the in-flight execution should be cancelled

## Switching Sessions

1. open the drawer
2. click `刷新列表`
3. choose another session explicitly
4. verify the session id and project path changed
5. verify the audit list recorded the switch

## Verifying External Access

1. open the public tunnel URL
2. pass Basic Auth
3. verify `mode: external` in the details drawer
4. verify the execution policy is what you intended
5. send a short prompt and confirm the transcript updates without page reload
