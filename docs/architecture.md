# Codex2Web Architecture

## Components

1. local bridge
2. browser client
3. optional tunnel entry

## Local Bridge Responsibilities

1. enumerate local Codex sessions
2. attach to one session by stable identity
3. read stream output
4. send follow-up input
5. expose explicit state: connected, attached, streaming, idle, error
6. apply an explicit browser execution profile instead of relying on implicit Codex CLI defaults

## Browser Responsibilities

1. bind to one session
2. render live output
3. send follow-up input
4. show session identity and local project context
5. show the active execution mode and trust boundary
6. never guess a different session silently

## Tunnel Responsibilities

1. expose the same browser entry externally
2. preserve auth and session pinning semantics
3. not introduce a second control model
4. enforce auth boundary before any external exposure
5. never silently expose dangerous execution power on the public path
6. allow remote dangerous execution only through an explicit trusted opt-in
