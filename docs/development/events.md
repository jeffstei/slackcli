# Event transport and artifact boundary

`src/commands/events.ts` owns CLI flags, cancellation and compact JSONL output.
`src/lib/events.ts` owns protocol v1, normalized message operations, stable
identities and bounded serialized output. `src/lib/events-transport.ts` adapts
the maintained MIT `gabriel-slack` core; ordinary command APIs stay in
`SlackClient`.

The new dependencies are intentional: published `gabriel-slack` 0.2.0 provides
the browser lifecycle, heartbeat, reconnect tickets and token refresh; `ws`
provides a hardened socket factory with explicit redirect refusal, frame limits
and cancellation. It is already Gabriel's dependency, not a second transport
runtime. Both are small compared with the standalone Bun runtime and avoid a
large hand-rolled protocol state machine. The 150 MB compiled budget still
applies. Newer GitHub source versions must not be confused with the installed
registry version.

Reference source inspected: Easy-Ez/gabriel-slack revision
`5ffca807c63fc07ce805638998f68f6034aa1da5`, plus the actual distributed 0.2.0
core declarations and WebSocket lifecycle. Keep dependency versions/lockfile
together; preserve their MIT notices in distributed binaries/packages.

## Security invariants

- Credentials resolve only through the selected workspace's existing
  SecretStore. Windows listeners require the DPAPI backend; existing file
  profiles need explicit verified migration.
- HTTP auth/refresh uses the process-wide rate limiter, cancellation and
  15-second request deadlines, strict origin/path checks and manual redirects.
  Bootstrap checks selected workspace and user identity.
- Cold and server-supplied reconnect URLs must be TLS on the exact approved
  Slack gateway hosts before any cookie is attached. Socket redirects are
  disabled, compression is disabled and frames are bounded.
- Gabriel's logger is deliberately silent: its records include partially
  redacted tokens and arbitrary server strings, contrary to this repository's
  policy. Our LogTape records contain only IDs, counters and stable states.
- The public protocol is a selected-field projection, never raw frames or
  reconnect tickets. Invalid frames/identities and queue overflow fail
  explicitly, never success-shaped drops.
- No consumer credentials, deployment settings or private host code belong in
  this public repository.

`dpapi.ts` implements CurrentUser Windows DPAPI through a constant script in the
Windows system PowerShell executable. Credentials travel through stdin, never
argv. Only ciphertext is written under LOCALAPPDATA, using opaque filenames
and atomic replacement. No token-adjacent state is written to OneDrive.
The existing verified save-before-delete migration remains authoritative.

## Protocol evolution

The CLI binary is the reusable artifact for consumers in different languages.
It does not require embedding Bun into another runtime. The `version` field is
the protocol major, independent of package SemVer. Breaking changes require a
new protocol major and consumer acceptance tests. Additive fields do not.
Stream IDs/sequences detect process continuity but are not Slack history
cursors. Keep stream and history deduplication semantics separate.

The streaming command is the explicit exception to finite one-object `--json`
output. Its `--fields` projection preserves identity and lifecycle envelope;
tests of finite read commands exclude this infinite command and its own
fixtures cover it. See [the user contract](../user-guide/events.md).

## Validation and release safety

```powershell
bun run type-check
bun test src/commands/events.test.ts src/lib/events.test.ts src/lib/events-transport.test.ts src/lib/dpapi.test.ts src/program.test.ts
bun run build:windows
```

The transport seam injects offline HTTP and a socket into the **real** Gabriel
core. Storage tests inject a protected-data runner and, on Windows, also run
one actual DPAPI round-trip with synthetic data only. Do not authenticate,
migrate real profiles or send live messages in automated tests.

`src/lib/events-v1.fixture.jsonl` is generated from the real producer's
normalization/lifecycle path with synthetic data. Its startup and reconnect
gaps precede readiness, and it includes duplicate create delivery. The producer
test pins that wire order. Consumer acceptance should use this same fixture,
not assume a ready-first stream or dispatch before verified identity.

Use the fork's own built artifacts and checksums. Upstream-only Homebrew/Discord
jobs must stay guarded by the upstream repository identity. Never push a tag
as an incidental implementation check; release publication is separate.
