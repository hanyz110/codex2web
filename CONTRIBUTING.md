# Contributing

Thanks for contributing to Codex2Web.

## Before You Start

Please align with the core product rules first:

1. session-first, not window-first
2. no silent session switching
3. project path is metadata, not the primary binding key
4. failures must stay explicit in the UI
5. external access must preserve an auth boundary

See:

1. `docs/prd.md`
2. `docs/sop.md`
3. `docs/architecture.md`

## Development Setup

1. install Node.js 20+
2. install Codex CLI locally
3. make sure this machine already has Codex session files
4. clone the repository
5. start local mode with `npm run dev`

## Typical Workflow

1. create a branch from `main`
2. make the smallest coherent change
3. update docs when behavior changes
4. run the relevant local verification
5. open a PR with a clear problem statement and validation notes

## Verification Expectations

For UI or bridge behavior changes, include the checks you ran.

Examples:

```bash
npm run dev
npm run spec:status
npm run spec:autoplan
```

Manual checks are acceptable when they are the only meaningful validation path. If so, document:

1. exact scenario
2. expected result
3. observed result

## Pull Request Guidelines

Please include:

1. what problem is being solved
2. what changed
3. what risks remain
4. how you verified the change
5. screenshots only if they do not expose sensitive local project data

## Security-Sensitive Areas

Be extra careful when changing:

1. execution profiles
2. tunnel launch logic
3. auth boundary handling
4. session restore and attach behavior
5. stop / send transport handling

## What Not To Do

1. do not add hidden session rebinding heuristics
2. do not bind by latest window or project name alone
3. do not weaken external auth requirements
4. do not expose dangerous remote execution by default
