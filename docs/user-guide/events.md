# Browser-session event streaming

This downstream fork supports an **opt-in, unofficial** Slack browser-client
WebSocket. It requires your own stored browser session, not a Slack app,
app-level token, Socket Mode or the official Events API. Slack can change or
withdraw this protocol without notice. Workspace policies still apply.

```powershell
slackcli events listen --json --workspace acme
```

`--json` is required. The listener remains running until SIGINT/SIGTERM,
terminal authentication/configuration failure, or output failure. Unlike finite
commands, stdout is **UTF-8 JSON Lines**, not one JSON document. Diagnostics and
structured terminal errors go to stderr. Do not copy the event stream into
diagnostic logs: it contains private Slack message text.

On Windows, protect an existing profile before listening:

```powershell
slackcli auth migrate-secrets --to dpapi --profile acme
```

Migration uses the existing confirmation gate and verifies the protected copy
before removing plaintext. It is not performed automatically by the listener.
DPAPI ciphertext lives in `%LOCALAPPDATA%\SlackCLI\secrets`, bound to the same
Windows user and machine. Do not put credentials, browser profiles or state on
OneDrive. Other platforms retain the existing file/macOS Keychain backends.

## Protocol v1

Every line has these fields:

| Field | Meaning |
|---|---|
| `protocol` | Always `slackcli.events` |
| `version` | Major protocol version, currently `1` |
| `workspace_id` | Selected authenticated workspace |
| `stream_id` | Random ID unique to this listener process |
| `sequence` | Positive increasing integer within this process, **not** a Slack resume cursor |
| `received_at` | Local UTC ISO-8601 timestamp |
| `kind` | `gap`, `ready`, `message` or `status` |

`ready` includes `user_id` and positive `generation`, and is emitted only after
the Slack `hello` handshake. A startup/reconnect `gap` precedes each readiness
record. A disconnect can emit a gap before the next readiness record; do not
reconcile with an unverified workspace/user identity.

`message` includes `event_id`, `channel_id`, `operation` (`create`, `edit`,
`delete`) and `message`:

```json
{"ts":"1712345678.123456","user":"U0123456789","text":"Hello","thread_ts":"1712345677.123456","client_msg_id":"12345678-1234-4234-8234-123456789012"}
```

Only `ts` is always present on the message object. Sender/text/thread/client
identity/subtype can be absent, especially on deletes. Do not execute edits,
deletes or reply-count notifications as fresh commands. Timestamps are strings;
keep their microsecond precision. `event_id` is stable for duplicate delivery
of a normalized operation. Consumers should additionally deduplicate creates
against history by workspace/channel/ts.

`gap` contains `reason`, `generation` and `since` (last local message receive
time, or `null` at startup). `since` is **not** proof of complete delivery or a
durable replay cursor. `status` currently carries `state: "reconnecting"`.

Lines are at most 1 MiB. The producer bounds its pending output to 256 records
and 4 MiB. A slow/closed pipe fails explicitly rather than dropping messages;
consumers must treat process loss as another gap. Output writes time out after
15 seconds. Unknown additive fields are compatible; unknown major versions
must fail closed. No token, cookie or authenticated gateway URL is exposed.

`--fields text` projects message content but preserves the protocol envelope,
operation and message identity (`ts`, `user`, `thread_ts`, `client_msg_id`).
Consumers should omit `--fields` unless they understand the projection.

## Reliability and consumer responsibilities

The transport provides handshake/dead-peer timeouts, heartbeat, bounded-jitter
reconnect, server-directed retry delays and browser-cookie token refresh.
Terminal session expiry is reported as an authentication failure. Refresh the
selected profile with the normal auth commands, then restart the listener.
It never changes the default workspace or chooses another identity on failure.

This is not exactly-once delivery, guaranteed replay or lossless history.
Persist accepted events before processing. Reconcile startup/disconnect gaps
with bounded history reads for explicitly configured channels and known
threads, overlap the boundary, and deduplicate through the same inbox. Channel
history alone does not recover every thread reply, edit or deletion. Report
truncation/incomplete recovery rather than declaring a clean checkpoint.
Normal operation needs no repeated broad discovery polling.

Sending remains an ordinary CLI operation. Text posts support
`messages send --client-message-id <uuid>` so a consumer can persist an outbound
intent **before** sending and correlate an early WebSocket echo before the
send response arrives. Record the confirmed channel/ts too. Slack's client ID
is a correlation aid, not a transactional exactly-once guarantee. Unknown send
outcomes must not be blindly retried.

When human and agent share the same identity, do not blanket-ignore the
authenticated user. Limit human input to explicitly authorized conversations
and senders, suppress only durable outbound identities, and pause ambiguous
routes until reconciliation resolves a possible echo.

## Build and acceptance

The fork does not assume an upstream release contains this capability. Build
the checked-out revision with `bun install --frozen-lockfile` and
`bun run build:windows`, then configure consumers with the absolute binary path.
Record the revision and SHA-256 alongside the artifact. Do not silently use the
upstream Homebrew binary or download `latest` during service startup.

Offline tests exercise the real library handshake with an injected socket,
plus projection, gaps, cancellation, output bounds, auth failure and protected
storage. These tests are not live Slack acceptance. A read-only live acceptance
requires an already authorized browser profile and a benign existing event;
it must not create channels, send messages or change Slack settings.
