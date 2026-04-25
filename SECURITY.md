# Security Policy

## Supported Scope

This repository is intended for local-first and self-hosted usage.

Please report security issues related to:

1. auth boundary bypass
2. external dangerous execution exposure
3. session cross-project leakage
4. unexpected remote command execution behavior
5. tunnel misconfiguration that weakens the documented trust boundary

## Reporting

If you discover a security issue, please do not open a public issue first.

Prefer private disclosure to the repository owner through GitHub security reporting or a private direct channel.

When reporting, include:

1. affected version or commit
2. exact setup
3. reproduction steps
4. expected vs actual behavior
5. impact assessment

## Response Expectations

Useful reports should be:

1. acknowledged quickly
2. reproduced when possible
3. fixed or mitigated with clear release notes

## Hard Security Boundaries

Codex2Web depends on these invariants:

1. external mode requires auth
2. remote dangerous execution must be explicit opt-in
3. session identity must not silently drift
4. browser-visible execution mode must match real execution mode

For operational guidance, see `docs/security.md`.
