---
summary: "Validate and deliver Gmail watcher payloads to Command Center through a default-off loopback adapter"
title: "Command Center mail adapter dry run"
read_when:
  - You are validating a Gmail watcher payload before enabling Command Center delivery
  - You need the delivery, retry, credential, or rollout boundary for the fleet mail adapter
---

# Command Center mail adapter

The adapter is split into two executables. Neither is installed or scheduled by this repository.

- The planner validates synthetic or captured documents with no provider, credential, listener, or
  network seam.
- The delivery adapter defaults to an offline configuration dry run. Its live listener exists for a
  later fleet rollout, but starting it requires two explicit flags and separately approved host,
  Gmail, Command Center, and canary work.

The watched `davin@thecaselygroup.com` source must be registered in Command Center as
`kind: "team"` (or the compatible legacy missing-kind shape), never `kind: "agent"`. Agent mailbox
registrations deliberately reject watcher ingestion.

## Payload planner

The fleet adapter planning command validates a `gog gmail watch serve` payload and builds the
corresponding Command Center ingest requests in memory. It emits only counts. This phase cannot
run provider commands, call Command Center, write cursor state, or deliver mail.

```bash
pnpm gmail:command-center:plan -- \
  --input ./synthetic-watch.json \
  --metadata ./synthetic-metadata.json \
  --mailbox watcher@example.test
```

The watch document uses the upstream Gmail watcher shape. The separate metadata document supplies
one exact RFC Message-ID receipt for each provider message:

```json
{
  "messages": [
    {
      "id": "provider-message-1",
      "rfcMessageId": "<synthetic-1@example.test>"
    }
  ]
}
```

The split is deliberate: the upstream watch payload carries the Gmail provider message and thread
ids but does not carry the RFC Message-ID header required by downstream reply provenance. A later,
separately approved runtime phase must obtain that receipt with a metadata-only provider read before
posting anything.

## Fail-closed contract

- The configured mailbox must exactly match the watcher account.
- Every planned message must be an `INBOX` message with one provider id, one provider thread id, one
  normalized sender address, a non-empty subject and complete plain-text body, and one exact
  bracketed RFC Message-ID receipt.
- Truncated bodies, missing receipts, account drift, malformed identities, and conflicting duplicate
  provider ids reject the whole plan.
- The provider message id becomes Command Center's stable `messageId` deduplication key.
- The configured mailbox, never the message's untrusted `To` header, becomes the ingest mailbox.
- `receivedAt` comes from the watcher payload's sender-controlled `Date` header because the upstream
  payload has no Gmail `internalDate`. A future sender clock therefore causes downstream directive
  windows to refuse rather than widen authority.
- Output is the count-only `cg-command-center-mail-ingest-plan-v1` summary. Sender, subject, body,
  provider ids, RFC ids, and request bodies are never printed.
- There is no `--apply`, `--send`, or `--deliver` mode.

## Default-off delivery adapter

The delivery executable validates its configuration and exits without reading credentials,
starting a listener, running `gog`, or making a network request unless both live flags are present:

```bash
pnpm gmail:command-center:deliver -- \
  --mailbox watcher@example.test \
  --command-center-url https://command-center.example.test \
  --command-center-token-file /path/to/command-center.token \
  --hook-token-file /path/to/local-hook.token
```

Dry-run output is the count-only `cg-command-center-mail-ingest-delivery-v1` summary. The two token
paths may be placeholders in this mode because their files are not opened.

The reviewed runtime path, when separately approved, has these boundaries:

1. Bind only `127.0.0.1:8789` at `/gmail-command-center`; no public listener option exists.
2. Require a distinct local hook bearer before parsing a payload.
3. Validate the complete watcher batch before provider access.
4. Run only the exact read-only `gog gmail get <provider-id> --format metadata --headers Message-ID`
   command for the configured account. The receipt must repeat the exact provider message/thread and
   contain exactly one bracketed RFC Message-ID header.
5. Build the same fail-closed plan, then POST requests sequentially to the fixed
   `/api/mail/messages` path on one HTTPS origin.
6. Accept only `201` with a fresh-row receipt or `200` with `duplicate: true`. Any provider,
   transport, status, or response-contract error produces a non-2xx hook response.

The upstream watcher preserves its pre-hook cursor and returns a delivery failure when the adapter
returns non-2xx. Pub/Sub can then retry. A partial retry converges because Command Center keys each
message by the stable Gmail provider id. See the upstream
[Gmail watcher error contract](https://github.com/openclaw/gogcli/blob/main/docs/watch.md#error-handling).

Current `gog` releases time out a downstream hook request after 10 seconds. The adapter does not
acknowledge early: `gog` retains its cursor while the authenticated handler finishes. After a full
success, the adapter retains only a bounded in-memory SHA-256 digest and count summary for the
notification, so an identical retry can receive a fast `200` without another provider read or
ingest POST. The cache is only an optimization; a restart loses it, and Command Center's stable
message-id deduplication remains the correctness boundary.

Credential files are deployment-held regular files owned by the service user, have exactly mode
`0600`, are not symlinks or hardlinks, and contain one token with no internal whitespace (a trailing
line ending is allowed). The Command Center bearer and local hook bearer must be different files.
Values, file paths, provider ids, response row ids,
sender, subject, body, and RFC ids never enter adapter output.

## Deployment gate

Do not run the live flags, install or schedule the adapter, configure `gog`/Gmail/Pub/Sub, authorize
OAuth, call Command Center production, or process live email from this code-review phase. A later
operator-approved rollout must verify all of the following before activation:

1. Exact Mac mini host/service ownership and a clean, pinned checkout.
2. The watched team mailbox registration and locally ready Gmail read authorization.
3. Distinct secret files and the dedicated Command Center watcher-agent identity.
4. `gog gmail watch` configuration that includes complete plain-text bodies and points its hook only
   at the loopback adapter.
5. A dry-run/configuration readback before using `--apply --confirm-live-delivery`.
6. Count-only canary and reconciliation, including one fresh receipt and one replayed duplicate.
7. Layla's certification that copied group-mail twins and receipt lanes remain excluded or handled
   exactly once.
