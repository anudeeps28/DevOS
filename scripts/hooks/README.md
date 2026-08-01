# Hook Forwarder

`forward-hook.mjs` forwards Claude Code hook events (raw JSON on stdin) from a
**foreign project's** Claude Code session to the DevOS server's hook-event bus,
so DevOS can observe activity across every project you have open — not just
the one it's running in.

## What the bus is

The DevOS server exposes a loopback-only HTTP endpoint at
`http://127.0.0.1:8787/hooks` (path `/hooks`, default port `8787`, overridable
via `PORT` on the server / `DEVOS_PORT` on the forwarder). Any local Claude
Code session — in any project on the machine — can POST its hook payloads
(`Notification`, `SessionStart`, `SessionEnd`, etc.) to this endpoint and the
DevOS server will pick them up.

## Security posture

- The server binds **loopback only** (`127.0.0.1` / `localhost` / `::1`) — it
  refuses to start bound to any other host. Nothing off-machine can reach it.
- The forwarder sends the hook payload verbatim; the server parses it
  defensively and enforces a body-size limit.
- **Opt-in per foreign project.** DevOS never installs this hook into another
  project automatically — you add it deliberately to `settings.json` in each
  project whose activity you want visible on the bus.
- The forwarder is **fail-open and silent by design**: it never writes to
  stdout (so it can never alter the foreign session's hook decision), it
  swallows all errors, and it always exits `0` — including when the DevOS
  server isn't running. A down bus never stalls or breaks the foreign Claude
  session.

## Install in a foreign project

Add a command-type hook to that project's `.claude/settings.json` (or
`~/.claude/settings.json` for a user-wide install) for each event you want
forwarded:

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /ABSOLUTE/path/to/DevOS/scripts/hooks/forward-hook.mjs"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /ABSOLUTE/path/to/DevOS/scripts/hooks/forward-hook.mjs"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /ABSOLUTE/path/to/DevOS/scripts/hooks/forward-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `/ABSOLUTE/path/to/DevOS/scripts/hooks/forward-hook.mjs` with the
absolute path to this script on your machine. This is a zero-dependency
Node ESM script — no `npm install` required.

### Port override

If the DevOS server is running on a non-default port, set `DEVOS_PORT` in the
environment the foreign Claude Code session (and therefore the hook command)
inherits:

```json
{
  "type": "command",
  "command": "DEVOS_PORT=9000 node /ABSOLUTE/path/to/DevOS/scripts/hooks/forward-hook.mjs"
}
```
