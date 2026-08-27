# Security Notes

## Default Security Model

Codex2Web is safe by default only when used as intended:

1. local mode on a trusted machine
2. external mode protected by Basic Auth
3. dangerous execution exposed remotely only with explicit opt-in

## Important Trust Boundaries

1. local mode can run with dangerous execution
2. external mode defaults to `full-auto`
3. external dangerous execution is allowed only with `--remote-trusted`

## External Access Rules

1. never expose the server externally without auth
2. rotate external passwords frequently
3. shut down tunnels when not actively using them
4. avoid sharing quick tunnel URLs in public channels
5. prefer a named Cloudflare tunnel if you need a stable hostname

## Recommended Password Practice

1. use a long random password
2. do not reuse passwords from other services
3. rotate after demos or temporary phone access sessions

## File Download Boundary

The authenticated download endpoint is scoped to the project of the session selected by the current browser client.

1. only absolute paths are accepted
2. both the project root and requested file are resolved with `realpath`
3. files outside the project, including symlink escapes, are rejected
4. directories and non-regular files are rejected
5. downloads are streamed and returned with `Content-Disposition: attachment` and `no-store`
6. file extensions are not restricted; PDF, Office files, images, archives, and other regular files use the same validation

## Operational Advice

1. treat `remote-trusted` as local shell-equivalent authority
2. do not run external dangerous mode on shared networks unless you fully control access
3. verify `execution.profile` before sending prompts from a remote phone

## What This Project Does Not Protect Against

1. a compromised machine that already has access to your local Codex sessions
2. weak or leaked Basic Auth credentials
3. unsafe prompts executed under dangerous mode
